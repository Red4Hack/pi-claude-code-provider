import { fileURLToPath } from "node:url";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const synchronousChildStdio = fileURLToPath(new URL("./synchronous-child-stdio.cjs", import.meta.url));

// Use these helpers for test-created Node children. See the preload for why
// buffered child output can become invisible in restricted sandboxes.
export function nodeFixtureSource(body) {
  return `#!/usr/bin/env node
require(${JSON.stringify(synchronousChildStdio)});
${body}
`;
}

export function nodeFixtureArgs(args) {
  return ["--require", synchronousChildStdio, ...args];
}

/** One executable convention for fake CLIs on Windows and POSIX. */
export async function createNodeFixture(body, { directory, prefix = "fake-claude-" } = {}) {
  directory ??= await mkdtemp(join(tmpdir(), prefix));
  const executable = join(directory, process.platform === "win32" ? "claude.cjs" : "claude");
  await writeFile(executable, nodeFixtureSource(body), { mode: 0o700 });
  await chmod(executable, 0o700);
  return { directory, executable };
}
