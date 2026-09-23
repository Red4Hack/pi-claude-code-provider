import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, lstat, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import { SessionImageStore } from "../../src/session-image-store.ts";

const imageName = (bytes) => `image-${createHash("sha256").update(bytes).digest("hex")}.png`;

/** release() fires the deferred reclaim without awaiting it, so poll for the removal. */
const waitForRemoval = async (directory) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      await access(directory);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`the image directory was never reclaimed: ${directory}`);
};

test("stable images survive concurrent requests and outlive a shutdown that must not wait", async () => {
  const store = new SessionImageStore();
  store.open();
  // Pi's RPC mode binds extensions twice for one session, so opening again keeps
  // the session's store rather than refusing the second bind.
  store.open();
  const bytes = Buffer.from("private image bytes");
  const first = store.acquire();
  const second = store.acquire();
  let directory;
  try {
    const [one, two] = await Promise.all([first.put(imageName(bytes), bytes), second.put(imageName(bytes), bytes)]);
    assert.equal(one, two);
    directory = first.directory;
    assert.ok(directory);
    assert.equal(second.directory, directory);
    assert.deepEqual(await readFile(one), bytes);
    if (process.platform !== "win32") {
      assert.equal((await lstat(directory)).mode & 0o777, 0o700);
      assert.equal((await lstat(one)).mode & 0o777, 0o600);
    }
    // Pi emits session_shutdown before it aborts the turn and awaits the handler
    // with no timeout, so a lease still outstanding belongs to a request nothing
    // has cancelled yet: close must return instead of holding Pi open for the rest
    // of the turn, and must keep the directory and the paths already handed out.
    await store.close();
    await access(directory);
    assert.equal(first.directory, directory);
    assert.equal(await first.put(imageName(bytes), bytes), one);
    // Releasing the last lease finishes the close that deferred to it. Nothing else
    // can: Pi emits session_shutdown once, so a second close() never arrives.
    first.release();
    second.release();
    await waitForRemoval(directory);
    // A repeated shutdown is then a no-op rather than a second removal of one tree.
    await store.close();
    await assert.rejects(access(directory));
    store.open();
    const resumed = store.acquire();
    const resumedPath = await resumed.put(imageName(bytes), bytes);
    assert.notEqual(resumedPath, one);
    resumed.release();
    await store.close();
  } finally {
    first.release();
    second.release();
    await store.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

test("rejects an image-store collision and retains uncertain-live state for stale cleanup", async () => {
  const store = new SessionImageStore();
  store.open();
  const lease = store.acquire();
  const bytes = Buffer.from("expected");
  let directory;
  try {
    const path = await lease.put(imageName(bytes), bytes);
    directory = lease.directory;
    await writeFile(path, "tampered");
    await assert.rejects(lease.put(imageName(bytes), bytes), (error) => error.code === "image_path");
    lease.release(true);
    await store.close();
    await access(directory);
  } finally {
    lease.release();
    await store.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

test("a deferred reclaim honors an uncertain-live release and still resets the store", async () => {
  // The production ordering: session_shutdown defers to an in-flight request, and
  // that request then reports a Claude child whose death it could not establish.
  // The directory has to survive for the stale-state pass, and the store still has
  // to forget it, or the next session inherits both the directory and the retention.
  const store = new SessionImageStore();
  store.open();
  const bytes = Buffer.from("uncertain liveness");
  const lease = store.acquire();
  let retained;
  let resumedDirectory;
  try {
    retained = await lease.put(imageName(bytes), bytes);
    await store.close();
    lease.release(true);
    // Nothing reclaims it, because the Claude child may still be reading it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await access(retained);
    // The store forgot it all the same, so the next session opens its own directory.
    store.open();
    const resumed = store.acquire();
    const resumedPath = await resumed.put(imageName(bytes), bytes);
    resumedDirectory = resumed.directory;
    assert.notEqual(resumedPath, retained);
    resumed.release();
    await store.close();
    await assert.rejects(access(resumedPath));
    // The retained directory is still the earlier session's, left for stale cleanup.
    await access(retained);
  } finally {
    if (retained) await rm(dirname(retained), { recursive: true, force: true });
    if (resumedDirectory) await rm(resumedDirectory, { recursive: true, force: true });
  }
});
