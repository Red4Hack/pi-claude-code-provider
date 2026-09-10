import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { superviseLiveProcess } from "./lib/live-process.js";
import { describePiLaunch, livePiLaunch } from "./lib/pi-installation.js";
import { DEFAULT_LOCAL_BASE_URL, DEFAULT_LOCAL_MODEL, createLocalClaudeExecutable } from "../test/support/local-claude.js";

/**
 * Free live lane: real Pi, the real provider transport, and a local llama.cpp
 * model standing in for Claude Code. It exercises what the paid lanes exercise
 * about *this* package — preflight, the proposal bridge, tool round trips, and
 * process cleanup — without spending subscription quota.
 *
 * It is not a compatibility gate. Only `npm run test:paid:*` can say what real
 * Claude Code emits; this lane can only say that the transport around it holds.
 */

const packageRoot = process.cwd();
const baseUrl = optionValue("--base-url") ?? process.env.PI_CLAUDE_LOCAL_BASE_URL ?? DEFAULT_LOCAL_BASE_URL;
const localModel = optionValue("--model") ?? process.env.PI_CLAUDE_LOCAL_MODEL ?? DEFAULT_LOCAL_MODEL;
const textOnly = process.argv.includes("--text-only");
/**
 * One knob for every deadline in the lane. A small model on modest hardware can
 * spend minutes on prompt processing alone before its first token, and this
 * stand-in answers in one piece, so the provider sees no protocol activity for
 * the whole of it. Generous by default; lower it with --timeout-ms when the
 * machine is fast enough that a hang should fail quickly instead.
 */
const LOCAL_TIMEOUT_MS = Number(optionValue("--timeout-ms") ?? process.env.PI_CLAUDE_LOCAL_TIMEOUT_MS ?? 60 * 60_000);
if (!Number.isSafeInteger(LOCAL_TIMEOUT_MS) || LOCAL_TIMEOUT_MS <= 0) {
  throw new Error("--timeout-ms must be a positive integer number of milliseconds");
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function spawnPi(args, options) {
  const launch = livePiLaunch(args);
  return spawn(launch.command, launch.args, {
    ...options,
    detached: process.platform !== "win32",
    windowsHide: process.platform === "win32",
  });
}

async function runPi(cwd, prompt, extra, environment) {
  const child = spawnPi([
    "--no-session",
    // A small local model pays for every token of prompt, so keep the system
    // prompt to the coding agent's own text: no context files, no templates.
    "--no-context-files",
    "--no-prompt-templates",
    "-e",
    packageRoot,
    "--provider",
    "pi-claude-code-provider",
    "--model",
    "sonnet:medium",
    ...extra,
    "-p",
    prompt,
  ], { cwd, env: { ...process.env, ...environment }, stdio: ["ignore", "pipe", "pipe"] });
  child.ref();
  child.stdout.ref();
  child.stderr.ref();
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const supervisor = superviseLiveProcess(child, { timeoutMs: LOCAL_TIMEOUT_MS, label: "Pi local test" });
  const { code, signal } = await supervisor.wait();
  if (code !== 0 || signal !== null) {
    throw new Error(`Pi exited with code ${String(code)}, signal ${String(signal)}: ${stderr.trim()}`);
  }
  return stdout.trim();
}

async function readMetrics(path) {
  const contents = await readFile(path, "utf8").catch(() => "");
  return contents.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/** Fail before launching Pi when the local model is simply not there. */
async function requireLocalModel() {
  let listed;
  try {
    const response = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    listed = await response.json();
  } catch (error) {
    throw new Error(
      `Local model server ${baseUrl} is unreachable (${error instanceof Error ? error.message : String(error)}). ` +
      "Start llama.cpp there, or pass --base-url.",
    );
  }
  const ids = (listed.data ?? []).map((entry) => entry.id);
  if (!ids.includes(localModel)) {
    throw new Error(`Local model ${localModel} is not served by ${baseUrl}. Available: ${ids.join(", ") || "none"}`);
  }
}

await requireLocalModel();
const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-local-"));
const workspace = join(directory, "workspace");
const agentDirectory = join(directory, "pi-agent");
const metricsLog = join(directory, "metrics.jsonl");
let failed = false;
try {
  await mkdir(workspace);
  await mkdir(agentDirectory);
  const executable = await createLocalClaudeExecutable(directory, { baseUrl, model: localModel, requestTimeoutMs: LOCAL_TIMEOUT_MS });
  const environment = {
    PI_CODING_AGENT_DIR: agentDirectory,
    PI_OFFLINE: "1",
    PI_CLAUDE_CODE_PROVIDER_PATH: executable,
    PI_CLAUDE_CODE_PROVIDER_METRICS_LOG: metricsLog,
    // The provider's production deadlines assume Claude Code's own latency.
    // A local model is slower by orders of magnitude, so the lane raises both
    // rather than letting an honest slow answer look like a hung process.
    PI_CLAUDE_CODE_PROVIDER_IDLE_TIMEOUT_MS: String(LOCAL_TIMEOUT_MS),
    PI_CLAUDE_CODE_PROVIDER_TOTAL_TIMEOUT_MS: String(LOCAL_TIMEOUT_MS),
  };
  console.log(`local lane: ${localModel} at ${baseUrl} (${describePiLaunch()}), ${Math.round(LOCAL_TIMEOUT_MS / 60_000)}min deadline`);

  const text = await runPi(workspace, "Reply with exactly: LOCAL-LANE-OK", ["--no-tools"], environment);
  assert.match(text, /LOCAL-LANE-OK/, `unexpected local reply: ${text}`);
  const afterText = await readMetrics(metricsLog);
  assert.equal(afterText.length, 1, "one provider request should have been recorded");
  assert.equal(afterText[0].errorCategory, undefined);
  assert.equal(afterText[0].stopReason, "stop");
  assert.equal(afterText[0].cleanupComplete, true);
  console.log("ok - local text turn through the provider transport");

  if (!textOnly) {
    // The turn that proves the proposal bridge started, listed its catalog, and
    // handed one call back to Pi. A --no-tools turn passes even with a dead bridge.
    // One tool, not the whole built-in set: the catalog is what the bridge has
    // to carry, and a narrow one keeps a 2B model's turn bounded.
    await runPi(
      workspace,
      "Use the write tool to create local-probe.txt containing exactly LOCAL-7319. Then reply exactly DONE.",
      ["--tools", "write"],
      environment,
    );
    const probe = await readFile(join(workspace, "local-probe.txt"), "utf8");
    assert.match(probe, /LOCAL-7319/, `unexpected probe contents: ${probe}`);
    const afterTools = await readMetrics(metricsLog);
    const handoff = afterTools.find((entry) => entry.stopReason === "toolUse");
    assert.ok(handoff, "no tool handoff was recorded");
    assert.equal(handoff.errorCategory, undefined);
    assert.equal(handoff.terminationExpected, true);
    assert.equal(handoff.cleanupComplete, true);
    assert.ok(handoff.toolCount > 0, "the handoff turn carried no tool catalog");
    console.log(`ok - proposal bridge tool round trip (${afterTools.length} provider requests)`);
  }

  const records = await readMetrics(metricsLog);
  assert.equal(records.every((entry) => entry.cleanupComplete), true, "every request must clean its private state");
  assert.equal(records.some((entry) => entry.errorCategory), false, "no request may end in an error category");
  console.log(`ok - ${records.length} local requests, no quota consumed`);
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.stack : String(error));
} finally {
  await rm(directory, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
