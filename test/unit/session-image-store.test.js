import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, lstat, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { SessionImageStore } from "../../src/session-image-store.ts";

const imageName = (bytes) => `image-${createHash("sha256").update(bytes).digest("hex")}.png`;

test("stable images survive concurrent requests and are removed after session shutdown", async () => {
  const store = new SessionImageStore();
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
    const closing = store.close();
    let closed = false;
    void closing.then(() => { closed = true; });
    await Promise.resolve();
    assert.equal(closed, false);
    first.release();
    second.release();
    await closing;
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
