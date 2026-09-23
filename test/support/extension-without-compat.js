/**
 * Load the extension in a process where `@earendil-works/pi-ai/compat` cannot be
 * resolved, which is what a Pi that deleted that temporary entrypoint looks like.
 * It runs as a child because the loader mapping is process-wide: the ordinary
 * test loader maps the subpath, and one test cannot unmap it for itself.
 *
 * Prints `ok` when the provider registered anyway. The parent supplies a fake
 * Claude through PI_CLAUDE_CODE_PROVIDER_PATH.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { locatePiPackages, packageEntry } from "../../scripts/lib/pi-installation.js";

const packages = locatePiPackages();
register(new URL("./pi-loader-hooks.js", import.meta.url), {
  parentURL: import.meta.url,
  data: {
    modules: {
      // Deliberately without "@earendil-works/pi-ai/compat"; nothing else resolves
      // it either, because this project installs no local node_modules.
      "@earendil-works/pi-coding-agent": pathToFileURL(packageEntry(packages.codingAgent, "import")).href,
      "@earendil-works/pi-ai": pathToFileURL(packageEntry(packages.piAi, "import")).href,
      typebox: pathToFileURL(packageEntry(packages.typebox, "import")).href,
    },
  },
});

await assert.rejects(import("@earendil-works/pi-ai/compat"), "the subpath must be unresolvable for this to prove anything");

const { default: piClaudeCodeProvider } = await import("../../extensions/index.ts");
const providers = new Map();
await piClaudeCodeProvider({
  registerCommand() {},
  registerProvider(name, config) { providers.set(name, config); },
  registerTool() {},
  on() {},
  getAllTools() { return []; },
});

assert.equal(typeof providers.get("pi-claude-code-provider")?.streamSimple, "function");
process.stdout.write("ok\n");
