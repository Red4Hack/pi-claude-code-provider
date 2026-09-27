import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import { captureEnvironment, captureTimeout, spawnCaptureChild, stopCaptureChild } from "../../scripts/lib/claude-capture.js";
import { SURFACE_CASES, captureSurfaceCase, surfaceErrors } from "../../scripts/lib/claude-surface.js";
import { createNodeFixture, nodeFixtureArgs } from "../support/node-fixture.js";
import { CAPTURED_CLAUDE_VERSION, CAPTURED_SURFACE_VERSION, PROVIDER_INIT_FIELDS, initRecord, startupSurface } from "../support/claude-fixture.js";
import { validateClaudeCapabilities } from "../../src/auth.ts";
import { terminateProcessGroup } from "../../src/process-utils.ts";
import { withTimeout } from "../support/wait.js";

test("capture cleanup removes a descendant after its leader closes", { skip: process.platform === "win32" }, async () => {
  // Independent stdio lets the leader close while its owned group stays alive.
  const body = `
const { spawn } = require("node:child_process");
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
descendant.unref();
process.stdout.write(String(descendant.pid) + "\\n");
`;
  const capture = spawnCaptureChild(process.execPath, nodeFixtureArgs(["-e", body]), {
    cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "ignore"],
  });
  let stdout = "";
  capture.child.stdout.on("data", (chunk) => { stdout += chunk; });
  try {
    assert.deepEqual(await withTimeout(capture.closed, "capture leader exit"), { code: 0, signal: null });
    const descendantPid = Number(stdout.trim());
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    assert.doesNotThrow(() => process.kill(descendantPid, 0), "descendant must outlive its leader");
    await stopCaptureChild(capture, 100);
    assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" });
  } finally {
    // Clean the group even when the cleanup assertion fails.
    await terminateProcessGroup(capture.child);
  }
});

test("the captured startup surface covers the complete effort matrix and names its producing version", async () => {
  const report = startupSurface();
  assert.equal(report.version, CAPTURED_SURFACE_VERSION);
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.cases.map((entry) => [entry.model, entry.requestedEffort]), SURFACE_CASES.map((entry) => [entry.model, entry.effort ?? null]));
  for (const entry of report.cases) {
    assert.equal(entry.initialization.claude_code_version, report.version);
    assert.deepEqual(surfaceErrors(entry), []);
  }
  const help = await readFile(new URL(`../support/captured/claude-${report.version}-help.txt`, import.meta.url), "utf8");
  validateClaudeCapabilities(help);
});

async function surfaceFixture({ preInit = [], plugins = [], effort, omitInit = false } = {}) {
  return createNodeFixture(`
process.stdin.resume();
for (const record of ${JSON.stringify(preInit)}) process.stdout.write(JSON.stringify(record) + "\\n");
${omitInit ? "" : `process.stdout.write(JSON.stringify(${JSON.stringify(initRecord(PROVIDER_INIT_FIELDS, { plugins, claude_code_version: CAPTURED_CLAUDE_VERSION }))}) + "\\n");`}
const effortIndex = process.argv.indexOf("--effort");
const requested = effortIndex === -1 ? undefined : process.argv[effortIndex + 1];
const sent = ${effort === undefined ? "requested" : JSON.stringify(effort)};
const request = require("node:http").request(process.env.ANTHROPIC_BASE_URL + "/v1/messages", { method: "POST" }, (response) => response.resume());
request.end(JSON.stringify({ output_config: sent === undefined ? {} : { effort: sent } }));
`);
}

test("surface capture observes every effort and omitted Haiku effort without inference", async () => {
  const fake = await surfaceFixture();
  try {
    for (const entry of SURFACE_CASES) {
      const captured = await captureSurfaceCase(fake.executable, entry);
      assert.deepEqual(surfaceErrors(captured), []);
      assert.equal(captured.observedEffort, entry.effort ?? null);
      assert.equal(captured.initialization.claude_code_version, CAPTURED_CLAUDE_VERSION);
    }
  } finally { await rm(fake.directory, { recursive: true, force: true }); }
});

test("surface capture retains plugin names and pre-init records before failing isolation", async () => {
  const fake = await surfaceFixture({ preInit: [{ type: "system", subtype: "commands_changed", cwd: "/tmp/capture-person-project" }], plugins: ["new@builtin"] });
  try {
    const captured = await captureSurfaceCase(fake.executable, { model: "sonnet", effort: "max" });
    assert.deepEqual(captured.initialization.plugins, ["new@builtin"]);
    assert.equal(captured.preInitRecords[0].cwd, "/capture");
    assert.match(surfaceErrors(captured).join("\n"), /system\/commands_changed/);
    assert.match(surfaceErrors(captured).join("\n"), /new@builtin/);
  } finally { await rm(fake.directory, { recursive: true, force: true }); }
});

test("surface capture detects an ignored effort flag", async () => {
  const fake = await surfaceFixture({ effort: "low" });
  try {
    const captured = await captureSurfaceCase(fake.executable, { model: "opus", effort: "max" });
    assert.match(surfaceErrors(captured).join("\n"), /effort mismatch: requested max, observed low/);
  } finally { await rm(fake.directory, { recursive: true, force: true }); }
});

test("surface capture reports missing or duplicate initialization", async () => {
  for (const [options, count] of [
    [{ omitInit: true }, 0],
    [{ preInit: [initRecord(PROVIDER_INIT_FIELDS)] }, 2],
  ]) {
    const fake = await surfaceFixture(options);
    try {
      const captured = await captureSurfaceCase(fake.executable, { model: "sonnet", effort: "max" });
      assert.match(surfaceErrors(captured).join("\n"), new RegExp(`expected one initialization, observed ${count}`));
    } finally { await rm(fake.directory, { recursive: true, force: true }); }
  }
});

test("capture authentication is restricted to loopback and ignores ambient routing", () => {
  const env = captureEnvironment("/capture-home", "http://127.0.0.1:1234");
  assert.equal(env.HOME, "/capture-home");
  assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(env.HTTPS_PROXY, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "local-capture-dummy-oauth-token");
  assert.throws(() => captureEnvironment("/capture-home", "https://api.anthropic.com"), /loopback/);
});

test("capture watchdog is cleared after resolution or rejection", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const schedule = globalThis.setTimeout;
  let fired = 0;
  t.mock.method(globalThis, "setTimeout", (callback, timeoutMs) => schedule(() => { fired++; callback(); }, timeoutMs));
  assert.equal(await captureTimeout(Promise.resolve("done"), "capture", 100), "done");
  await assert.rejects(captureTimeout(Promise.reject(new Error("failure")), "capture", 100), /failure/);
  t.mock.timers.tick(100);
  assert.equal(fired, 0);
  const pending = captureTimeout(new Promise(() => {}), "hung capture", 100);
  const rejected = assert.rejects(pending, /hung capture timed out/);
  t.mock.timers.tick(100);
  await rejected;
});
