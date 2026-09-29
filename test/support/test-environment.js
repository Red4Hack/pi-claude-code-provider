import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { after } from "node:test";
import { waitFor } from "./wait.js";

const PRIVATE_STATE_PREFIX = "pi-claude-code-provider-";

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

// Name what was left and what keeps the worker alive, so a teardown failure on a
// CI runner identifies the leaking state instead of only reporting a timeout.
async function describeLeftovers(directory) {
  const names = (await readdir(directory)).filter((name) => name.startsWith(PRIVATE_STATE_PREFIX)).sort();
  const entries = await Promise.all(names.map(async (name) => {
    try {
      const marker = JSON.parse(await readFile(join(directory, name, ".pi-claude-code-provider-runtime.json"), "utf8"));
      const child = marker.childPid === undefined ? "no child" : `child ${processAlive(marker.childPid) ? "alive" : "gone"}`;
      return `${name} (${marker.kind}, ${child})`;
    } catch {
      return `${name} (no readable marker)`;
    }
  }));
  return `leftover: ${entries.join("; ")}; active resources: ${process.getActiveResourcesInfo().join(", ")}`;
}

// The preload runs in the test coordinator too. Only isolated test workers need
// a root; every spawned fixture inherits it, on Windows as well as POSIX.
if (process.env.NODE_TEST_CONTEXT === "child-v8") {
  const directory = mkdtempSync(join(tmpdir(), "pi-provider-test-worker-"));
  process.env.TMPDIR = directory;
  process.env.TEMP = directory;
  process.env.TMP = directory;
  after(async () => {
    // Check before removing the root: otherwise teardown could hide a leak.
    try {
      await waitFor(async () => !(await readdir(directory)).some((name) => name.startsWith(PRIVATE_STATE_PREFIX)), "worker runtime cleanup");
    } catch (error) {
      throw new Error(`${error.message}; ${await describeLeftovers(directory)}`, { cause: error });
    }
  });
  process.once("exit", () => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
}
