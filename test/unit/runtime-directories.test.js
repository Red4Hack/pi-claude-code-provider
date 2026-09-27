import assert from "node:assert/strict";
import { access, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
  cleanupStaleRuntimeDirectories,
  confirmRuntimeChildExit,
  createRuntimeDirectory,
  reapRuntimeStateAtExit,
  recordRuntimeChild,
  removeRuntimeDirectory,
  retainRuntimeDirectory,
} from "../../src/runtime-directories.ts";

const HOUR = 60 * 60_000;

test("creates private marked runtime directories and records the child process", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-directory-test-"));
  const createdAt = Date.now() - 2 * HOUR;
  try {
    const directory = await createRuntimeDirectory("provider_request", {
      temporaryRoot: root,
      ownerPid: 101,
      now: createdAt,
    });
    assert.match(directory, /pi-claude-code-provider-request-/);
    if (process.platform !== "win32") assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    const markerName = (await readdir(directory)).find((name) => name.startsWith(".pi-claude-code-provider-runtime"));
    assert.ok(markerName);
    const markerPath = join(directory, markerName);
    if (process.platform !== "win32") assert.equal((await lstat(markerPath)).mode & 0o777, 0o600);
    await recordRuntimeChild(directory, 202);
    assert.deepEqual(JSON.parse(await readFile(markerPath, "utf8")), {
      schema: "pi-claude-code-provider-runtime-v1",
      kind: "provider_request",
      ownerPid: 101,
      childPid: 202,
      createdAt: new Date(createdAt).toISOString(),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removes only old runtime directories whose recorded processes are gone", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-cleanup-test-"));
  const now = Date.now();
  try {
    const stale = await createRuntimeDirectory("provider_request", { temporaryRoot: root, ownerPid: 301, now: now - 2 * HOUR });
    const staleImages = await createRuntimeDirectory("provider_image_store", { temporaryRoot: root, ownerPid: 307, now: now - 2 * HOUR });
    // The web_search_output prefix nests inside the web_search_request prefix,
    // so this directory is only reclaimed when its kind is resolved by the
    // longest matching prefix rather than the first one.
    const staleOutput = await createRuntimeDirectory("web_search_output", { temporaryRoot: root, ownerPid: 306, now: now - 2 * HOUR });
    const activeOwner = await createRuntimeDirectory("provider_request", { temporaryRoot: root, ownerPid: 302, now: now - 2 * HOUR });
    const activeChild = await createRuntimeDirectory("web_search_request", { temporaryRoot: root, ownerPid: 303, now: now - 2 * HOUR });
    await recordRuntimeChild(activeChild, 304);
    const young = await createRuntimeDirectory("provider_request", { temporaryRoot: root, ownerPid: 305, now });
    const removed = await cleanupStaleRuntimeDirectories({
      temporaryRoot: root,
      currentUid: (await lstat(root)).uid,
      now,
      processAlive: (pid) => pid === 302 || pid === 304,
    });
    assert.deepEqual(removed, { removed: 3, failures: 0 });
    await assert.rejects(access(stale));
    await assert.rejects(access(staleImages));
    await assert.rejects(access(staleOutput));
    await Promise.all([activeOwner, activeChild, young].map((directory) => access(directory)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("leaves unowned, unmarked, diagnostic, symlinked, and out-of-budget candidates untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-cleanup-safety-test-"));
  const now = Date.now();
  try {
    const valid = await createRuntimeDirectory("provider_request", { temporaryRoot: root, ownerPid: 401, now: now - 2 * HOUR });
    const unmarked = await mkdtemp(join(root, "pi-claude-code-provider-request-"));
    const malformed = await mkdtemp(join(root, "pi-claude-code-provider-request-"));
    await writeFile(join(malformed, ".pi-claude-code-provider-runtime.json"), "not json\n", { mode: 0o600 });
    const diagnostic = await mkdtemp(join(root, "pi-claude-code-provider-diagnostics-"));
    const outside = await mkdtemp(join(root, "outside-"));
    const linked = join(root, "pi-claude-code-provider-request-linked");
    await symlink(outside, linked, process.platform === "win32" ? "junction" : undefined);
    const currentUid = (await lstat(root)).uid;
    assert.deepEqual(await cleanupStaleRuntimeDirectories({
      temporaryRoot: root,
      currentUid: currentUid + 1,
      now,
      processAlive: () => false,
    }), { removed: 0, failures: 0 });
    assert.deepEqual(await cleanupStaleRuntimeDirectories({
      temporaryRoot: root,
      currentUid,
      now,
      maxDeletionAttempts: 0,
      processAlive: () => false,
    }), { removed: 0, failures: 0 });
    await Promise.all([valid, unmarked, malformed, diagnostic, outside, linked].map((directory) => access(directory)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retains a stale session image store while an owned request child may be alive", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-image-child-test-"));
  const now = Date.now();
  try {
    const images = await createRuntimeDirectory("provider_image_store", { temporaryRoot: root, ownerPid: 501, now: now - 2 * HOUR });
    const request = await createRuntimeDirectory("provider_request", { temporaryRoot: root, ownerPid: 501, now: now - 2 * HOUR });
    await recordRuntimeChild(request, 502);
    const options = { temporaryRoot: root, currentUid: (await lstat(root)).uid, now };
    assert.deepEqual(await cleanupStaleRuntimeDirectories({ ...options, processAlive: (pid) => pid === 502 }), { removed: 0, failures: 0 });
    await Promise.all([images, request].map((directory) => access(directory)));
    assert.deepEqual(await cleanupStaleRuntimeDirectories({ ...options, processAlive: () => false }), { removed: 2, failures: 0 });
    await Promise.all([images, request].map((directory) => assert.rejects(access(directory))));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports a content-free aggregate when the temporary root cannot be scanned", async () => {
  const missing = join(tmpdir(), `pi-runtime-missing-${process.pid}-${Date.now()}`);
  assert.deepEqual(await cleanupStaleRuntimeDirectories({
    temporaryRoot: missing,
    currentUid: 0,
  }), { removed: 0, failures: 1 });
});

test("drains stale images beyond the deletion budget without counting retained entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-budget-test-"));
  const now = Date.now();
  try {
    const images = [];
    for (let i = 0; i < 4; i++) images.push(await createRuntimeDirectory("provider_image_store", { temporaryRoot: root, ownerPid: 601, now: now - 2 * HOUR }));
    images.sort();
    const markerPath = join(images[0], ".pi-claude-code-provider-runtime.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    await writeFile(markerPath, JSON.stringify({ ...marker, ownerPid: 602 }));
    const options = { temporaryRoot: root, currentUid: (await lstat(root)).uid, now, maxDeletionAttempts: 1, processAlive: (pid) => pid === 602 };
    for (let i = 0; i < 3; i++) assert.deepEqual(await cleanupStaleRuntimeDirectories(options), { removed: 1, failures: 0 });
    assert.deepEqual(await readdir(root), [basename(images[0])]);
    assert.deepEqual(await cleanupStaleRuntimeDirectories(options), { removed: 0, failures: 0 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a surviving group beyond the deletion budget protects its request and images", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-group-test-"));
  const now = Date.now();
  try {
    const images = await createRuntimeDirectory("provider_image_store", { temporaryRoot: root, ownerPid: 701, now: now - 2 * HOUR });
    const request = await createRuntimeDirectory("provider_request", { temporaryRoot: root, ownerPid: 701, now: now - 2 * HOUR });
    await recordRuntimeChild(request, 702);
    const options = { temporaryRoot: root, currentUid: (await lstat(root)).uid, now, maxDeletionAttempts: 1 };
    assert.deepEqual(await cleanupStaleRuntimeDirectories({ ...options, processAlive: (pid) => pid === -702 }), { removed: 0, failures: 0 });
    await Promise.all([images, request].map((path) => access(path)));
    for (let i = 0; i < 2; i++) assert.deepEqual(await cleanupStaleRuntimeDirectories({ ...options, processAlive: () => false }), { removed: 1, failures: 0 });
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed deletions consume the budget and incomplete ownership inspection retains images", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-failure-test-"));
  const now = Date.now();
  try {
    const images = await createRuntimeDirectory("provider_image_store", { temporaryRoot: root, ownerPid: 801, now: now - 2 * HOUR });
    const request = await createRuntimeDirectory("provider_request", { temporaryRoot: root, ownerPid: 801, now: now - 2 * HOUR });
    const options = { temporaryRoot: root, currentUid: (await lstat(root)).uid, now, processAlive: () => false };
    let attempts = 0;
    assert.deepEqual(await cleanupStaleRuntimeDirectories({ ...options, maxDeletionAttempts: 1, removeDirectory: async () => { attempts++; throw new Error("synthetic removal failure"); } }), { removed: 0, failures: 1 });
    assert.equal(attempts, 1);
    assert.deepEqual(await cleanupStaleRuntimeDirectories({ ...options, inspectDirectory: async (path) => {
      if (basename(path) === basename(request)) throw new Error("synthetic inspection failure");
      return lstat(path);
    } }), { removed: 0, failures: 1 });
    await Promise.all([images, request].map((path) => access(path)));
    assert.deepEqual(await cleanupStaleRuntimeDirectories(options), { removed: 2, failures: 0 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("permission-denied group probes retain state until absence is established", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-probe-test-"));
  const now = Date.now();
  try {
    await createRuntimeDirectory("provider_image_store", { temporaryRoot: root, ownerPid: 901, now: now - 2 * HOUR });
    const request = await createRuntimeDirectory("provider_request", { temporaryRoot: root, ownerPid: 901, now: now - 2 * HOUR });
    await recordRuntimeChild(request, 902);
    const options = { temporaryRoot: root, currentUid: (await lstat(root)).uid, now };
    let groupExists = true;
    t.mock.method(process, "kill", (pid, signal) => {
      assert.equal(signal, 0);
      throw Object.assign(new Error("synthetic probe"), { code: pid === -902 && groupExists ? "EPERM" : "ESRCH" });
    });
    assert.deepEqual(await cleanupStaleRuntimeDirectories(options), { removed: 0, failures: 0 });
    groupExists = false;
    assert.deepEqual(await cleanupStaleRuntimeDirectories(options), { removed: 2, failures: 0 });
  } finally { t.mock.restoreAll(); await rm(root, { recursive: true, force: true }); }
});

// The exit registry is process-global and the real reaper runs when this worker
// exits, so every directory a reaper test registers is removed through
// removeRuntimeDirectory, which also unregisters it: a fake child PID must never
// reach a real SIGKILL.
async function reaperFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-reaper-test-"));
  const created = [];
  const create = async (kind) => {
    const directory = await createRuntimeDirectory(kind, { temporaryRoot: root });
    created.push(directory);
    return directory;
  };
  t.after(async () => {
    await Promise.all(created.map((directory) => removeRuntimeDirectory(directory)));
    await rm(root, { recursive: true, force: true });
  });
  return { create };
}

async function exists(path) {
  return access(path).then(() => true, () => false);
}

function recordingKill(outcomes = {}) {
  const calls = [];
  const kill = (pid, signal) => {
    calls.push([pid, signal]);
    const code = outcomes[pid];
    if (code) throw Object.assign(new Error(code), { code });
    return true;
  };
  return { calls, kill };
}

test("the exit reaper forces unconfirmed children down and removes owned state", async (t) => {
  const { create } = await reaperFixture(t);
  const unconfirmed = await create("provider_request");
  await recordRuntimeChild(unconfirmed, 424_242);
  const confirmed = await create("provider_request");
  await recordRuntimeChild(confirmed, 434_343);
  confirmRuntimeChildExit(confirmed);
  const vanished = await create("web_search_request");
  await recordRuntimeChild(vanished, 444_444);
  const unlaunched = await create("provider_request");
  const images = await create("provider_image_store");
  const output = await create("web_search_output");
  const { calls, kill } = recordingKill({ [-444_444]: "ESRCH" });

  reapRuntimeStateAtExit({ platform: "linux", kill });

  assert.deepEqual(calls.filter(([pid]) => [-424_242, -434_343, -444_444].includes(pid)), [[-424_242, "SIGKILL"], [-444_444, "SIGKILL"]]);
  for (const directory of [unconfirmed, confirmed, vanished, unlaunched, images, output]) {
    assert.equal(await exists(directory), false, basename(directory));
  }
  // Reclaimed entries leave the registry, so a second pass signals nothing of theirs.
  const again = recordingKill();
  reapRuntimeStateAtExit({ platform: "linux", kill: again.kill });
  assert.deepEqual(again.calls.filter(([pid]) => pid === -424_242), []);
});

test("the exit reaper keeps state whose child may live, and image stores with it", async (t) => {
  const { create } = await reaperFixture(t);
  const denied = await create("provider_request");
  await recordRuntimeChild(denied, 515_151);
  const retained = await create("provider_request");
  await recordRuntimeChild(retained, 525_252);
  retainRuntimeDirectory(retained);
  const images = await create("provider_image_store");
  const output = await create("web_search_output");
  const { calls, kill } = recordingKill({ [-515_151]: "EPERM" });

  // A live member behind the EPERM; a zombie-only group would be reclaimed.
  reapRuntimeStateAtExit({ platform: "linux", kill, groupMemberStates: (pgid) => (pgid === 515_151 ? ["S"] : []) });

  assert.deepEqual(calls.filter(([pid]) => pid === -525_252), [], "a retained child is not signalled");
  assert.equal(await exists(denied), true, "a child whose death is unknown keeps its request state");
  assert.equal(await exists(retained), true, "liveness-unknown state is kept at exit too");
  assert.equal(await exists(images), true, "a possibly live child protects image stores");
  assert.equal(await exists(output), false, "state no child can use is still removed");
});

test("a retained image store is kept at exit", async (t) => {
  const { create } = await reaperFixture(t);
  const images = await create("provider_image_store");
  retainRuntimeDirectory(images);
  reapRuntimeStateAtExit({ platform: "linux", kill: recordingKill().kill });
  assert.equal(await exists(images), true);
});

test("the Windows exit reaper uses the owned PID's tree and keeps state it cannot confirm", async (t) => {
  const { create } = await reaperFixture(t);
  const statuses = { 616_161: 0, 626_262: 128, 636_363: 1, 646_464: null };
  const directories = {};
  for (const pid of Object.keys(statuses).map(Number)) {
    directories[pid] = await create("provider_request");
    await recordRuntimeChild(directories[pid], pid);
  }
  const exited = await create("provider_request");
  await recordRuntimeChild(exited, 656_565, { exitCode: 0, signalCode: null });
  const taskkilled = [];

  reapRuntimeStateAtExit({
    platform: "win32",
    taskkill: (pid) => {
      taskkilled.push(pid);
      return pid in statuses ? statuses[pid] : 0;
    },
  });

  assert.deepEqual(taskkilled.filter((pid) => pid in statuses || pid === 656_565).sort(), [616_161, 626_262, 636_363, 646_464]);
  assert.equal(await exists(directories[616_161]), false, "taskkill success");
  assert.equal(await exists(directories[626_262]), false, "process already gone");
  assert.equal(await exists(directories[636_363]), true, "taskkill failure keeps state");
  assert.equal(await exists(directories[646_464]), true, "an incomplete taskkill keeps state");
  assert.equal(await exists(exited), false, "an exited leader needs no taskkill");
});

test("only a completed removal ends registration, and a failing removal never throws", async (t) => {
  const { create } = await reaperFixture(t);
  const removed = await create("web_search_output");
  await removeRuntimeDirectory(removed);
  const stubborn = await create("web_search_output");
  const attempted = [];
  assert.doesNotThrow(() => reapRuntimeStateAtExit({
    remove: (directory) => {
      attempted.push(directory);
      if (directory === stubborn) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    },
  }));
  assert.equal(attempted.includes(removed), false, "a directory already removed is no longer owned");
  assert.equal(attempted.includes(stubborn), true);
  // Still registered after the failure, so a later pass can reclaim it.
  reapRuntimeStateAtExit({ platform: "linux", kill: recordingKill().kill });
  assert.equal(await exists(stubborn), false);
});

test("one exit listener serves every evaluation of the module", async (t) => {
  const { create } = await reaperFixture(t);
  await create("web_search_output");
  const installed = process.listenerCount("exit");
  const second = await import(`../../src/runtime-directories.ts?evaluation=${Date.now()}`);
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-reaper-second-"));
  try {
    for (let index = 0; index < 5; index += 1) {
      const directory = await second.createRuntimeDirectory("web_search_output", { temporaryRoot: root });
      await create("web_search_output");
      // The first evaluation's reaper sees the second evaluation's directories.
      reapRuntimeStateAtExit({ platform: "linux", kill: recordingKill().kill });
      assert.equal(await exists(directory), false);
    }
    assert.equal(process.listenerCount("exit"), installed);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
