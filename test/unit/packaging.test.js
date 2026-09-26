import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { locatePiPackages, packageEntry } from "../../scripts/lib/pi-installation.js";
import { createNodeFixture } from "../support/node-fixture.js";
import { claudeFixtureBody } from "../support/claude-fixture.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
// The banner formatter has no public export. Invoke the installed Pi's method:
// copying its algorithm here would let an upstream naming change pass unnoticed.
const piEntry = pathToFileURL(packageEntry(locatePiPackages().codingAgent, "import"));
const { InteractiveMode } = await import(new URL("./modes/interactive/interactive-mode.js", piEntry));
const { loadExtensions } = await import(new URL("./core/extensions/loader.js", piEntry));
const mode = Object.create(InteractiveMode.prototype);

for (const route of ["local", "npm", "git"]) {
  test(`Pi resolves and labels a ${route} package through its root entry`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-packaging-"));
    const agentDir = join(directory, "agent");
    const roots = {
      local: join(directory, manifest.name),
      npm: join(agentDir, "npm", "node_modules", manifest.name),
      git: join(agentDir, "git", "github.com", "chem", manifest.name),
    };
    const sources = { local: roots.local, npm: `npm:${manifest.name}`, git: `git:github.com/chem/${manifest.name}` };
    const fake = await createNodeFixture(claudeFixtureBody("", { preflight: true }), { directory });
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = fake.executable;
    try {
      await mkdir(roots[route], { recursive: true });
      for (const name of ["package.json", "index.ts", "src", "bridge"]) {
        await cp(join(packageRoot, name), join(roots[route], name), { recursive: true });
      }
      const manager = new DefaultPackageManager({ cwd: directory, agentDir, settingsManager: SettingsManager.inMemory() });
      const resolved = await manager.resolveExtensionSources([sources[route]]);
      assert.deepEqual(resolved.extensions.map((entry) => entry.path), [join(roots[route], "index.ts")]);
      assert.deepEqual(mode.getCompactExtensionLabels(resolved.extensions.map((entry) => ({ path: entry.path, sourceInfo: entry.metadata }))),
        [route === "git" ? `chem/${manifest.name}` : manifest.name]);
      // Pi's loader transpiles npm TypeScript; Node's native type stripper
      // deliberately refuses files under node_modules.
      const loaded = await loadExtensions(resolved.extensions.map((entry) => entry.path), directory);
      assert.deepEqual(loaded.errors, []);
      assert.equal(loaded.extensions.length, 1);
      assert.equal(loaded.runtime.pendingProviderRegistrations[0].name, manifest.name);
      for (const handler of loaded.extensions[0].handlers.get("session_shutdown")) await handler({}, {});
      loaded.runtime.invalidate();
    } finally {
      if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
      else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
      await rm(directory, { recursive: true, force: true });
    }
  });
}
