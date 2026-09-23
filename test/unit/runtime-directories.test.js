import assert from "node:assert/strict";
import { access, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
  cleanupStaleRuntimeDirectories,
  createRuntimeDirectory,
  recordRuntimeChild,
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
    assert.deepEqual(removed, { removed: 3, failures: 0, reaped: 0 });
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
    }), { removed: 0, failures: 0, reaped: 0 });
    assert.deepEqual(await cleanupStaleRuntimeDirectories({
      temporaryRoot: root,
      currentUid,
      now,
      maxDeletionAttempts: 0,
      processAlive: () => false,
    }), { removed: 0, failures: 0, reaped: 0 });
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
    assert.deepEqual(await cleanupStaleRuntimeDirectories({ ...options, processAlive: (pid) => pid === 502 }), { removed: 0, failures: 0, reaped: 0 });
    await Promise.all([images, request].map((directory) => access(directory)));
    assert.deepEqual(await cleanupStaleRuntimeDirectories({ ...options, processAlive: () => false }), { removed: 2, failures: 0, reaped: 0 });
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
  }), { removed: 0, failures: 1, reaped: 0 });
});

test("reaps an abandoned Claude process group only when the live process proves it owns the directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-reap-test-"));
  const now = Date.now();
  try {
    const abandoned = await createRuntimeDirectory("provider_request", { temporaryRoot: root, ownerPid: 501, now: now - 2 * HOUR });
    await recordRuntimeChild(abandoned, 502);
    const impostor = await createRuntimeDirectory("web_search_request", { temporaryRoot: root, ownerPid: 503, now: now - 2 * HOUR });
    await recordRuntimeChild(impostor, 504);
    const currentUid = (await lstat(root)).uid;
    const terminated = [];
    // 504 is a live process that does not reference the recorded directory, which
    // is what a reused process identifier looks like: it must never be signalled,
    // and its unprovable state must leave the directory in place too.
    const result = await cleanupStaleRuntimeDirectories({
      temporaryRoot: root,
      currentUid,
      now,
      processAlive: (pid) => pid === 502 || pid === 504,
      processOwnsDirectory: async (pid, directory) => pid === 502 && directory === abandoned,
      terminateGroup: async (pid) => {
        terminated.push(pid);
        return true;
      },
    });
    assert.deepEqual(result, { removed: 1, failures: 0, reaped: 1 });
    assert.deepEqual(terminated, [502]);
    await assert.rejects(access(abandoned));
    await access(impostor);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("counts a process group that refuses to die as a failure and keeps its directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-reap-failure-test-"));
  const now = Date.now();
  try {
    const stubborn = await createRuntimeDirectory("provider_request", { temporaryRoot: root, ownerPid: 601, now: now - 2 * HOUR });
    await recordRuntimeChild(stubborn, 602);
    assert.deepEqual(await cleanupStaleRuntimeDirectories({
      temporaryRoot: root,
      currentUid: (await lstat(root)).uid,
      now,
      processAlive: (pid) => pid === 602,
      processOwnsDirectory: async (_pid, directory) => directory === stubborn,
      terminateGroup: async () => false,
    }), { removed: 0, failures: 1, reaped: 0 });
    await access(stubborn);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reaping is bounded per pass so Pi startup cannot stall behind it", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-reap-budget-test-"));
  const now = Date.now();
  try {
    const directories = [];
    for (let index = 0; index < 3; index += 1) {
      const directory = await createRuntimeDirectory("provider_request", { temporaryRoot: root, ownerPid: 700 + index, now: now - 2 * HOUR });
      await recordRuntimeChild(directory, 800 + index);
      directories.push(directory);
    }
    const terminated = [];
    const result = await cleanupStaleRuntimeDirectories({
      temporaryRoot: root,
      currentUid: (await lstat(root)).uid,
      now,
      maxReaped: 1,
      processAlive: (pid) => pid >= 800,
      processOwnsDirectory: async (pid, directory) => directories[pid - 800] === directory,
      terminateGroup: async (pid) => {
        terminated.push(pid);
        return true;
      },
    });
    assert.equal(result.reaped, 1);
    assert.equal(result.removed, 1);
    assert.equal(terminated.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
    for (let i = 0; i < 3; i++) assert.deepEqual(await cleanupStaleRuntimeDirectories(options), { removed: 1, failures: 0, reaped: 0 });
    assert.deepEqual(await readdir(root), [basename(images[0])]);
    assert.deepEqual(await cleanupStaleRuntimeDirectories(options), { removed: 0, failures: 0, reaped: 0 });
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
    assert.deepEqual(await cleanupStaleRuntimeDirectories({ ...options, processAlive: (pid) => pid === -702 }), { removed: 0, failures: 0, reaped: 0 });
    await Promise.all([images, request].map((path) => access(path)));
    for (let i = 0; i < 2; i++) assert.deepEqual(await cleanupStaleRuntimeDirectories({ ...options, processAlive: () => false }), { removed: 1, failures: 0, reaped: 0 });
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
    assert.deepEqual(await cleanupStaleRuntimeDirectories({ ...options, maxDeletionAttempts: 1, removeDirectory: async () => { attempts++; throw new Error("synthetic removal failure"); } }), { removed: 0, failures: 1, reaped: 0 });
    assert.equal(attempts, 1);
    assert.deepEqual(await cleanupStaleRuntimeDirectories({ ...options, inspectDirectory: async (path) => {
      if (basename(path) === basename(request)) throw new Error("synthetic inspection failure");
      return lstat(path);
    } }), { removed: 0, failures: 1, reaped: 0 });
    await Promise.all([images, request].map((path) => access(path)));
    assert.deepEqual(await cleanupStaleRuntimeDirectories(options), { removed: 2, failures: 0, reaped: 0 });
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
    assert.deepEqual(await cleanupStaleRuntimeDirectories(options), { removed: 0, failures: 0, reaped: 0 });
    groupExists = false;
    assert.deepEqual(await cleanupStaleRuntimeDirectories(options), { removed: 2, failures: 0, reaped: 0 });
  } finally { t.mock.restoreAll(); await rm(root, { recursive: true, force: true }); }
});
