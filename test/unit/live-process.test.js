import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import test from "node:test";
import { assistantReply, closeLiveRpcProcess, consumeJsonl, superviseLiveProcess } from "../../scripts/lib/live-process.js";

test("a live assistant reply reports a provider error by name rather than as empty text", () => {
  const end = (message) => ({ type: "message_end", message });
  const reply = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "OK" }] };
  assert.equal(assistantReply([end({ role: "user" }), end(reply)], "case"), reply);
  assert.throws(
    () => assistantReply([end({ role: "assistant", stopReason: "error", errorMessage: "usage credits are disabled", content: [] })], "fable:medium"),
    { message: "fable:medium: usage credits are disabled" },
  );
  assert.throws(() => assistantReply([end({ role: "user" })], "cache turn 1"), { message: "cache turn 1 returned no assistant message" });
});

test("live-process supervision clears normal exits and enforces deadlines", async () => {
  const clean = spawn(process.execPath, ["-e", "process.exit(0)"], { detached: true, stdio: "ignore" });
  assert.deepEqual(await superviseLiveProcess(clean, { timeoutMs: 1_000, label: "clean" }).wait(), {
    code: 0,
    signal: null,
  });

  const hung = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  await assert.rejects(
    superviseLiveProcess(hung, { timeoutMs: 30, label: "hung" }).wait(),
    /hung exceeded 30ms/,
  );
});

test("live RPC shutdown prefers stdin EOF and bounds forced-cleanup fallback", async () => {
  const spawnOptions = {
    detached: process.platform !== "win32",
    windowsHide: process.platform === "win32",
    stdio: ["pipe", "ignore", "ignore"],
  };
  const clean = spawn(process.execPath, ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"], spawnOptions);
  const cleanSupervisor = superviseLiveProcess(clean, { timeoutMs: 2_000, label: "clean RPC" });
  const cleanClosed = cleanSupervisor.wait();
  assert.deepEqual(await closeLiveRpcProcess(clean, cleanSupervisor, cleanClosed, 500), {
    result: { code: 0, signal: null },
    graceful: true,
  });

  const hung = spawn(process.execPath, ["-e", "process.stdin.resume(); setInterval(() => {}, 1000);"], spawnOptions);
  const hungSupervisor = superviseLiveProcess(hung, { timeoutMs: 2_000, label: "hung RPC" });
  const hungClosed = hungSupervisor.wait();
  const forced = await closeLiveRpcProcess(hung, hungSupervisor, hungClosed, 100);
  assert.equal(forced.graceful, false);
  assert.equal(hung.exitCode !== null || hung.signalCode !== null, true);
});

test("live JSONL consumption reports parser failures through its callback", async () => {
  const stream = new PassThrough();
  const values = [];
  const failure = new Promise((resolve) => {
    consumeJsonl(stream, (value) => values.push(value), resolve);
  });
  stream.end('{"ok":true}\nmalformed\n');
  assert.match((await failure).message, /malformed JSONL/);
  assert.deepEqual(values, [{ ok: true }]);
});
