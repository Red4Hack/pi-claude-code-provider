import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanupStaleRuntimeDirectories, createRuntimeDirectory, recordRuntimeChild } from "../../src/runtime-directories.ts";
import { isProcessAlive } from "../../src/process-utils.ts";
import { nodeFixtureArgs } from "../support/node-fixture.js";

/**
 * The reaper with no seams: a real detached process group, the real `/proc`
 * ownership proof, and a real signal. An abruptly killed Pi leaves exactly this
 * behind — a Claude process group holding memory with nothing left to report to
 * — and the seam-driven cases cannot show that the production path works.
 */

const HOUR = 60 * 60_000;

/** A process identifier that is certainly dead: one this test watched exit. */
async function deadPid() {
  const child = spawn(process.execPath, nodeFixtureArgs(["-e", ""]), { stdio: "ignore" });
  await new Promise((resolve) => child.once("close", resolve));
  return child.pid;
}

function spawnDetached(cwd, extraArgs = []) {
  const child = spawn(process.execPath, nodeFixtureArgs(["-e", "setInterval(() => {}, 1000)", ...extraArgs]), {
    cwd,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child;
}

async function waitForExit(pid) {
  for (let attempt = 0; attempt < 100 && isProcessAlive(pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !isProcessAlive(pid);
}

test("an abandoned process group whose Pi owner is gone is terminated and its state removed", async (t) => {
  if (process.platform !== "linux") return t.skip("ownership proof reads /proc");
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-reaper-"));
  let child;
  try {
    const directory = await createRuntimeDirectory("provider_request", {
      temporaryRoot: root,
      ownerPid: await deadPid(),
      now: Date.now() - 2 * HOUR,
    });
    child = spawnDetached(directory);
    await recordRuntimeChild(directory, child.pid);
    assert.equal(isProcessAlive(child.pid), true);

    // No seams: the real process probe, the real /proc proof, the real signal.
    const result = await cleanupStaleRuntimeDirectories({ temporaryRoot: root, currentUid: (await lstat(root)).uid });
    assert.deepEqual(result, { removed: 1, failures: 0, reaped: 1 });
    assert.equal(await waitForExit(child.pid), true, "the abandoned group should be gone");
    await assert.rejects(access(directory), "its private state should be removed");
  } finally {
    if (child?.pid && isProcessAlive(child.pid)) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("a provider child running in Pi's session directory is proven by its command line", async (t) => {
  if (process.platform !== "linux") return t.skip("ownership proof reads /proc");
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-reaper-argv-"));
  let child;
  try {
    const directory = await createRuntimeDirectory("provider_request", {
      temporaryRoot: root,
      ownerPid: await deadPid(),
      now: Date.now() - 2 * HOUR,
    });
    // Provider requests run Claude in Pi's session directory rather than the
    // private one, and name the private system-prompt file on the command line.
    child = spawnDetached(root, [join(directory, "system-prompt.txt")]);
    await recordRuntimeChild(directory, child.pid);

    const result = await cleanupStaleRuntimeDirectories({ temporaryRoot: root, currentUid: (await lstat(root)).uid });
    assert.deepEqual(result, { removed: 1, failures: 0, reaped: 1 });
    assert.equal(await waitForExit(child.pid), true, "the abandoned group should be gone");
    await assert.rejects(access(directory), "its private state should be removed");
  } finally {
    if (child?.pid && isProcessAlive(child.pid)) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("a live process that does not reference the recorded directory is never signalled", async (t) => {
  if (process.platform !== "linux") return t.skip("ownership proof reads /proc");
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-reaper-safety-"));
  let child;
  try {
    const directory = await createRuntimeDirectory("provider_request", {
      temporaryRoot: root,
      ownerPid: await deadPid(),
      now: Date.now() - 2 * HOUR,
    });
    // Runs elsewhere and names nothing inside the directory: this is what a
    // reused process identifier looks like, and
    // signalling it would kill a stranger's process.
    child = spawnDetached(root);
    await recordRuntimeChild(directory, child.pid);

    const result = await cleanupStaleRuntimeDirectories({ temporaryRoot: root, currentUid: (await lstat(root)).uid });
    assert.deepEqual(result, { removed: 0, failures: 0, reaped: 0 });
    assert.equal(isProcessAlive(child.pid), true, "an unproven process must be left alone");
    await access(directory);
  } finally {
    if (child?.pid && isProcessAlive(child.pid)) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    }
    await rm(root, { recursive: true, force: true });
  }
});
