export const SETTLE_TIMEOUT_MS = 10_000;

/** Bound an observation, and clear its watchdog on either completion path. */
export async function withTimeout(pending, label, timeoutMs = SETTLE_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Poll only where no event or promise exposes the observable state. */
export async function waitFor(probe, label, timeoutMs = SETTLE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new Error(`${label} did not settle within ${timeoutMs}ms`);
}

export function waitForPath(path) {
  return waitFor(async () => {
    try { await access(path); return true; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  }, `path ${path}`);
}

export function waitForRemoval(path) {
  return waitFor(async () => {
    try { await access(path); return false; }
    catch (error) { if (error.code === "ENOENT") return true; throw error; }
  }, `removal of ${path}`);
}
import { access } from "node:fs/promises";
