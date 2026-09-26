import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { after } from "node:test";
import { waitFor } from "./wait.js";

// The preload runs in the test coordinator too. Only isolated test workers need
// a root; every spawned fixture inherits it, on Windows as well as POSIX.
if (process.env.NODE_TEST_CONTEXT === "child-v8") {
  const directory = mkdtempSync(join(tmpdir(), "pi-provider-test-worker-"));
  process.env.TMPDIR = directory;
  process.env.TEMP = directory;
  process.env.TMP = directory;
  after(async () => {
    // Check before removing the root: otherwise teardown could hide a leak.
    await waitFor(async () => !(await readdir(directory)).some((name) => name.startsWith("pi-claude-code-provider-")), "worker runtime cleanup");
  });
  process.once("exit", () => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
}
