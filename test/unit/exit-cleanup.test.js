import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { VERIFIED_VERSIONS } from "../../src/compatibility.ts";
import { closeLiveRpcProcess, superviseLiveProcess } from "../../scripts/lib/live-process.js";
import { piCliEntry } from "../../scripts/lib/pi-installation.js";
import { claudeFixtureBody } from "../support/claude-fixture.js";
import { createNodeFixture, nodeFixtureArgs } from "../support/node-fixture.js";
import { waitFor } from "../support/wait.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const PRIVATE_STATE = ["pi-claude-code-provider-request-", "pi-claude-code-provider-images-"];

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([typeBytes, data])) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, typeBytes, data, checksum]);
}

// A decodable image Pi passes through, so the request also leases the session
// image store. Pi drops an image it cannot decode before the provider sees it.
function greenPng(size = 32) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [0, 255, 0]).flat())]);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function privateState() {
  return (await readdir(tmpdir())).filter((name) => PRIVATE_STATE.some((prefix) => name.startsWith(prefix))).sort();
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

/**
 * Pi awaits session_shutdown, then its dispose aborts the turn, then it exits at
 * once, so a request still in flight never reaches its asynchronous cleanup.
 * Claude's own pid file proves the request launched before the host went away.
 */
async function exitMidRequest(t, exit) {
  const directory = await mkdtemp(join(tmpdir(), "exit-cleanup-fixture-"));
  const pidPath = join(directory, "claude.pid");
  const { executable } = await createNodeFixture(claudeFixtureBody(`
require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
process.stdin.resume();
setInterval(() => {}, 1000);
`, { preflight: true, writeReady: true, version: VERIFIED_VERSIONS.claudeCode }), { directory });
  const before = await privateState();
  const child = spawn(process.execPath, nodeFixtureArgs([
    piCliEntry(), "--mode", "rpc", "--no-session", "--no-extensions", "-e", root,
    "--no-skills", "--no-context-files", "--provider", "pi-claude-code-provider",
    "--model", "sonnet:medium", "--no-tools",
  ]), {
    cwd: directory,
    detached: process.platform !== "win32",
    windowsHide: process.platform === "win32",
    env: { ...process.env, PI_CODING_AGENT_DIR: join(directory, "agent"), PI_CLAUDE_CODE_PROVIDER_PATH: executable },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const supervisor = superviseLiveProcess(child, { timeoutMs: 20_000, label: "exit-cleanup Pi fixture" });
  const closed = supervisor.wait();
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-64 * 1024); });
  child.stdout.resume();
  let claudePid;
  try {
    child.stdin.write(`${JSON.stringify({
      type: "prompt",
      message: "Describe this image.",
      images: [{ type: "image", data: greenPng().toString("base64"), mimeType: "image/png" }],
    })}\n`);
    await waitFor(async () => existsSync(pidPath), `fake Claude launch (${stderr})`);
    claudePid = Number(await readFile(pidPath, "utf8"));
    const during = (await privateState()).filter((name) => !before.includes(name));
    assert.deepEqual(during.map((name) => PRIVATE_STATE.find((prefix) => name.startsWith(prefix))).sort(), [...PRIVATE_STATE].sort(), "the request did not hold both kinds of private state");

    const result = await exit(child, supervisor, closed);
    assert.equal(result.signal, null, stderr);

    assert.deepEqual((await privateState()).filter((name) => !before.includes(name)), [], "private state outlived the host process");
    await waitFor(async () => !processExists(claudePid), "fake Claude termination");
  } finally {
    if (child.exitCode === null && child.signalCode === null) await supervisor.terminate().catch(() => {});
    if (claudePid && processExists(claudePid)) {
      try { process.kill(claudePid, "SIGKILL"); } catch {}
    }
    await rm(directory, { recursive: true, force: true });
  }
}

test("closing Pi mid-request reclaims its private request and image state", async (t) => {
  await exitMidRequest(t, async (child, supervisor, closed) => {
    const shutdown = await closeLiveRpcProcess(child, supervisor, closed, 10_000);
    assert.equal(shutdown.graceful, true);
    return shutdown.result;
  });
});

test("terminating Pi mid-request reclaims its private request and image state", async (t) => {
  // Windows has no SIGTERM to deliver: process.kill terminates Pi outright, which
  // no exit listener can observe.
  if (process.platform === "win32") return t.skip("SIGTERM is not a graceful Windows exit");
  await exitMidRequest(t, async (child, _supervisor, closed) => {
    child.kill("SIGTERM");
    return closed;
  });
});
