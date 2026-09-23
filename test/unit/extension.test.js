import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { normalizeContext } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, DefaultPackageManager, SettingsManager, formatSize } from "@earendil-works/pi-coding-agent";
import initializePiClaudeCodeProvider from "../../extensions/index.ts";
import implementation from "../../extensions/pi-claude-code-provider.ts";
import { VERIFIED_VERSIONS, platformStatus } from "../../src/compatibility.ts";
import { CAPTURED_CLAUDE_HELP_PATH, ELIGIBLE_CLAUDE_AUTH } from "../support/claude-fixture.js";
import { nodeFixtureSource } from "../support/node-fixture.js";
import { sessionRegistry } from "../../src/session-registry.ts";

// Pi folds `systemPrompt` and `tools` into transcript system messages before a
// provider is reached. Fixtures normalize through Pi's own helper so they carry
// the shape the provider actually receives; the pre-normalization shape would
// leave those fields where nothing reads them.
const baseMessages = [{ role: "user", content: "hello", timestamp: 1 }];
const providerContext = (init = {}) => normalizeContext({ messages: baseMessages, tools: [], ...init });
import { completeSimple, getApiProvider, resetApiProviders, unregisterApiProviders } from "@earendil-works/pi-ai/compat";

const piClaudeCodeProvider = (pi) => initializePiClaudeCodeProvider(pi);

function fakePi(initialTools = []) {
    const commands = new Map();
    const handlers = new Map();
    const providers = new Map();
    const tools = new Map(initialTools.map((tool) => [tool.name, tool]));
    return {
        commands,
        handlers,
        providers,
        tools,
        api: {
            registerCommand(name, options) { commands.set(name, options); },
            registerProvider(name, config) { providers.set(name, config); },
            registerTool(tool) { tools.set(tool.name, tool); },
            on(event, handler) {
                const values = handlers.get(event) ?? [];
                values.push(handler);
                handlers.set(event, values);
            },
            getAllTools() { return [...tools.values()]; },
        },
    };
}

// Sessions are registered process-wide, so one test leaving a session open would
// silently change how the next test's requests resolve.
test.beforeEach(() => {
    assert.deepEqual([...sessionRegistry().keys()], []);
    // The Pi-AI registry is process-wide too, and an instance that never starts a
    // session keeps its registration, which is correct but not a clean slate.
    unregisterApiProviders("pi-claude-code-provider");
});

let sessionCounter = 0;

// Pi identifies the session a request belongs to, so every started session needs
// its own id; the provider keys its per-session state on it.
function sessionContext(cwd, ui) {
    const sessionId = `session-${++sessionCounter}`;
    return { cwd, ui, sessionManager: { getSessionId: () => sessionId } };
}

async function createFakeClaude(searchResult = "ok", { searchDelayMs = 0, rateLimitInfo, reportCwd = false, providerTools = [], holdProviderUntilInput = false } = {}) {
    const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-extension-"));
    const executable = join(directory, process.platform === "win32" ? "claude.cjs" : "claude");
    const rateLimitEvents = Array.isArray(rateLimitInfo) ? rateLimitInfo : rateLimitInfo ? [rateLimitInfo] : [];
    const init = { type: "system", subtype: "init", tools: ["WebFetch", "WebSearch"], mcp_servers: [], model: "claude-sonnet-5", permissionMode: "dontAsk", slash_commands: [], skills: [], plugins: [], apiKeySource: "none" };
    const providerInit = {
        ...init,
        tools: providerTools.map((name) => `mcp__pi__${name}`),
        mcp_servers: providerTools.length ? [{ name: "pi", status: "connected" }] : [],
    };
    // Keep fake Claude JSONL visible in sandboxes that lose buffered Node child stdout.
    await writeFile(executable, nodeFixtureSource(`
if (process.argv.includes("--version")) process.stdout.write(${JSON.stringify(`${VERIFIED_VERSIONS.claudeCode}\n`)});
else if (process.argv[2] === "auth" && process.argv[3] === "status") process.stdout.write(JSON.stringify(${JSON.stringify(ELIGIBLE_CLAUDE_AUTH)}));
else if (process.argv.includes("--help")) process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(CAPTURED_CLAUDE_HELP_PATH)}, "utf8"));
else {
  const mcpIndex = process.argv.indexOf("--mcp-config");
  if (mcpIndex >= 0) {
    const ready = JSON.parse(process.argv[mcpIndex + 1]).mcpServers?.pi?.env?.PI_CLAUDE_TOOL_READY;
    if (ready) require("node:fs").writeFileSync(ready, "ready\\n", { flag: "wx" });
  }
  const providerMode = process.argv.includes("--system-prompt-file");
  const send = () => {
    process.stdout.write(JSON.stringify(providerMode ? ${JSON.stringify(providerInit)} : ${JSON.stringify(init)}) + "\\n");
    for (const rateLimitInfo of ${JSON.stringify(rateLimitEvents)}) process.stdout.write(JSON.stringify({type:"rate_limit_event",rate_limit_info:rateLimitInfo}) + "\\n");
    process.stdout.write(JSON.stringify({type:"result",is_error:false,result:${reportCwd ? "providerMode ? process.cwd() : " : ""}${JSON.stringify(searchResult)}}) + "\\n");
  };
  if (providerMode && ${holdProviderUntilInput}) {
    process.stdin.resume();
    process.stdin.on("end", send);
  } else setTimeout(send, ${searchDelayMs});
}
`), { mode: 0o700 });
    await chmod(executable, 0o700);
    return { directory, executable };
}

test("platform acknowledgement hides only the startup advisory and leaves doctor truthful", async (t) => {
    const status = platformStatus();
    if (!status.warning) return t.skip("host has no platform advisory");
    const { directory, executable } = await createFakeClaude();
    const originalPath = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    const originalAcknowledgement = process.env.PI_CLAUDE_CODE_PROVIDER_ACKNOWLEDGED_PLATFORM;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const pi = fakePi();
        await piClaudeCodeProvider(pi.api);
        const notices = [];
        const ctx = sessionContext(tmpdir(), { notify(message, level) { notices.push({ message, level }); } });
        delete process.env.PI_CLAUDE_CODE_PROVIDER_ACKNOWLEDGED_PLATFORM;
        pi.handlers.get("session_start")[0]({}, ctx);
        assert.ok(notices.some(({ message }) => message.includes(status.warning)));
        await pi.handlers.get("session_shutdown")[0]({}, {});
        notices.length = 0;
        process.env.PI_CLAUDE_CODE_PROVIDER_ACKNOWLEDGED_PLATFORM = status.current;
        pi.handlers.get("session_start")[0]({}, ctx);
        assert.equal(notices.some(({ message }) => message.includes(status.warning)), false);
        await pi.commands.get("pi-claude-code-provider-doctor").handler("", ctx);
        assert.ok(notices.some(({ message }) => message.includes(`Platform ${status.current} (unverified;`)));
        await pi.handlers.get("session_shutdown")[0]({}, {});
    } finally {
        if (originalPath === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = originalPath;
        if (originalAcknowledgement === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_ACKNOWLEDGED_PLATFORM;
        else process.env.PI_CLAUDE_CODE_PROVIDER_ACKNOWLEDGED_PLATFORM = originalAcknowledgement;
        await rm(directory, { recursive: true, force: true });
    }
});

test("sole-directory compatibility flag is required for a markerless tool-bearing side Agent", async () => {
    const parent = await mkdtemp(join(tmpdir(), "provider-extension-parent-"));
    const child = await mkdtemp(join(tmpdir(), "provider-extension-child-"));
    const { directory, executable } = await createFakeClaude("ok", { reportCwd: true, providerTools: ["read"], holdProviderUntilInput: true });
    const oldPath = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    const oldBorrow = process.env.PI_CLAUDE_CODE_PROVIDER_BORROW_SOLE_DIRECTORY;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    delete process.env.PI_CLAUDE_CODE_PROVIDER_BORROW_SOLE_DIRECTORY;
    let shutdown;
    try {
        const pi = fakePi();
        await piClaudeCodeProvider(pi.api);
        shutdown = pi.handlers.get("session_shutdown")[0];
        const provider = pi.providers.get("pi-claude-code-provider");
        const model = {
            ...provider.models.find((candidate) => candidate.id === "sonnet"),
            provider: "pi-claude-code-provider",
            api: "pi-claude-code-provider-headless",
            baseUrl: "pi-claude-code-provider://local",
        };
        pi.handlers.get("session_start")[0]({}, sessionContext(parent, { notify() { } }));
        const sideContext = providerContext({
            systemPrompt: `You are a side Agent.\nWorking directory: ${child}\nReview this request.`,
            tools: [{ name: "read", description: "read", parameters: { type: "object", properties: {} } }],
        });
        const strict = await provider.streamSimple(model, sideContext).result();
        assert.equal(strict.stopReason, "error");
        assert.match(strict.errorMessage ?? "", /refusing to borrow the sole live session/);
        process.env.PI_CLAUDE_CODE_PROVIDER_BORROW_SOLE_DIRECTORY = "on";
        const borrowed = await provider.streamSimple(model, sideContext).result();
        assert.equal(borrowed.stopReason, "stop", borrowed.errorMessage);
        assert.equal(await realpath(borrowed.content.find((block) => block.type === "text")?.text), await realpath(parent));
    } finally {
        if (shutdown) await shutdown({}, {});
        if (oldPath === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = oldPath;
        if (oldBorrow === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_BORROW_SOLE_DIRECTORY;
        else process.env.PI_CLAUDE_CODE_PROVIDER_BORROW_SOLE_DIRECTORY = oldBorrow;
        await Promise.all([parent, child, directory].map((path) => rm(path, { recursive: true, force: true })));
    }
});

test("routes rate-limit warnings to the active Pi UI and launches nothing before a session starts", async () => {
    const { directory, executable } = await createFakeClaude("ok", { rateLimitInfo: {
        status: "allowed_warning",
        rateLimitType: "five_hour",
        utilization: 0.876,
        resetsAt: 1_800_000_000,
    } });
    const original = {
        executable: process.env.PI_CLAUDE_CODE_PROVIDER_PATH,
        metrics: process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG,
    };
    const metricsPath = join(directory, "metrics.jsonl");
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG = metricsPath;
    try {
        const pi = fakePi();
        await piClaudeCodeProvider(pi.api);
        const provider = pi.providers.get("pi-claude-code-provider");
        assert.ok(provider);
        const configured = provider.models.find((model) => model.id === "sonnet");
        const model = {
            ...configured,
            provider: "pi-claude-code-provider",
            api: "pi-claude-code-provider-headless",
            baseUrl: "pi-claude-code-provider://local",
        };
        const context = providerContext();
        // Before any session there is no working directory to run Claude in.
        const early = await provider.streamSimple(model, context, { reasoning: "medium" }).result();
        assert.equal(early.stopReason, "error");
        assert.match(early.errorMessage ?? "", /session working directory is not available/);

        const notices = [];
        pi.handlers.get("session_start")[0]({}, sessionContext(tmpdir(), { notify(message, level) { notices.push({ message, level }); } }));
        assert.equal((await provider.streamSimple(model, context, { reasoning: "medium" }).result()).stopReason, "stop");
        const warning = notices.find(({ message }) => message.includes("rate limit warning"));
        assert.deepEqual(warning, {
            message: `[pi-claude-code-provider] Claude rate limit warning: 87% used (five_hour); resets at ${new Date(1_800_000_000_000).toLocaleString()}`,
            level: "warning",
        });
        // A seven_day window resets up to a week out, so a bare wall-clock time
        // reads as "today" and understates the wait by days.
        const reset = new Date(1_800_000_000_000);
        assert.ok(warning.message.includes(String(reset.getFullYear())) || warning.message.includes(String(reset.getFullYear() % 100)));
        assert.ok(!warning.message.endsWith(`resets at ${reset.toLocaleTimeString()}`));
        await pi.handlers.get("session_shutdown")[0]({}, {});
        const records = (await readFile(metricsPath, "utf8")).trim().split("\n").map(JSON.parse);
        assert.equal(records.length, 2);
        assert.deepEqual(records.map((record) => record.errorCategory ?? null), ["working_directory", null]);
        assert.equal(records.every((record) => record.requestedModel === "sonnet"), true);
    }
    finally {
        if (original.executable === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original.executable;
        if (original.metrics === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG;
        else process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG = original.metrics;
        await rm(directory, { recursive: true, force: true });
    }
});

test("does not report a disabled overage as a rate limit", async () => {
    // The steady state on a subscription without usage credits: the plan window
    // is healthy and overage is administratively unavailable on every event.
    const { directory, executable } = await createFakeClaude("ok", { rateLimitInfo: {
        status: "allowed",
        rateLimitType: "five_hour",
        utilization: 0.11,
        resetsAt: 1_800_000_000,
        overageStatus: "rejected",
        overageDisabledReason: "org_level_disabled",
        isUsingOverage: false,
    } });
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const pi = fakePi();
        await piClaudeCodeProvider(pi.api);
        const provider = pi.providers.get("pi-claude-code-provider");
        const configured = provider.models.find((model) => model.id === "sonnet");
        const model = {
            ...configured,
            provider: "pi-claude-code-provider",
            api: "pi-claude-code-provider-headless",
            baseUrl: "pi-claude-code-provider://local",
        };
        const notices = [];
        pi.handlers.get("session_start")[0]({}, sessionContext(tmpdir(), { notify(message, level) { notices.push({ message, level }); } }));
        const context = providerContext();
        assert.equal((await provider.streamSimple(model, context, { reasoning: "medium" }).result()).stopReason, "stop");
        assert.deepEqual(notices.filter(({ message }) => message.includes("rate limit")), []);
        // A session left open would stay registered for the whole test file, and
        // this tool-free request would borrow its directory as a summary.
        await pi.handlers.get("session_shutdown")[0]({}, {});
    }
    finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await rm(directory, { recursive: true, force: true });
    }
});

test("reports a repeated rate-limit warning once per session", async () => {
    const warning = {
        status: "allowed_warning",
        rateLimitType: "five_hour",
        utilization: 0.77,
        resetsAt: 1_800_000_000,
    };
    // Claude repeats the notice within one process and across the fresh process
    // this transport spawns for every tool round-trip.
    const { directory, executable } = await createFakeClaude("ok", { rateLimitInfo: [warning, warning] });
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const pi = fakePi();
        await piClaudeCodeProvider(pi.api);
        const provider = pi.providers.get("pi-claude-code-provider");
        const configured = provider.models.find((model) => model.id === "sonnet");
        const model = {
            ...configured,
            provider: "pi-claude-code-provider",
            api: "pi-claude-code-provider-headless",
            baseUrl: "pi-claude-code-provider://local",
        };
        const notices = [];
        pi.handlers.get("session_start")[0]({}, sessionContext(tmpdir(), { notify(message, level) { notices.push({ message, level }); } }));
        const context = providerContext();
        await provider.streamSimple(model, context, { reasoning: "medium" }).result();
        await provider.streamSimple(model, context, { reasoning: "medium" }).result();
        assert.deepEqual(notices.filter(({ message }) => message.includes("rate limit")), [{
            message: `[pi-claude-code-provider] Claude rate limit warning: 77% used (five_hour); resets at ${new Date(1_800_000_000_000).toLocaleString()}`,
            level: "warning",
        }]);

        // A new session starts from a clean slate.
        await pi.handlers.get("session_shutdown")[0]({}, {});
        const later = [];
        pi.handlers.get("session_start")[0]({}, sessionContext(tmpdir(), { notify(message, level) { later.push({ message, level }); } }));
        await provider.streamSimple(model, context, { reasoning: "medium" }).result();
        assert.equal(later.filter(({ message }) => message.includes("rate limit")).length, 1);
        await pi.handlers.get("session_shutdown")[0]({}, {});
    }
    finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await rm(directory, { recursive: true, force: true });
    }
});

test("reports one warning while utilization moves within the displayed percent", async () => {
    // Utilization arrives as a changing fraction; the notice shows whole percent.
    const warning = (utilization) => ({ status: "allowed_warning", rateLimitType: "five_hour", utilization, resetsAt: 1_800_000_000 });
    const { directory, executable } = await createFakeClaude("ok", { rateLimitInfo: [warning(0.871), warning(0.874)] });
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const pi = fakePi();
        await piClaudeCodeProvider(pi.api);
        const provider = pi.providers.get("pi-claude-code-provider");
        const configured = provider.models.find((model) => model.id === "sonnet");
        const model = {
            ...configured,
            provider: "pi-claude-code-provider",
            api: "pi-claude-code-provider-headless",
            baseUrl: "pi-claude-code-provider://local",
        };
        const notices = [];
        pi.handlers.get("session_start")[0]({}, sessionContext(tmpdir(), { notify(message, level) { notices.push({ message, level }); } }));
        const context = providerContext();
        await provider.streamSimple(model, context, { reasoning: "medium" }).result();
        assert.deepEqual(notices.filter(({ message }) => message.includes("rate limit")).map(({ message }) => message), [
            `[pi-claude-code-provider] Claude rate limit warning: 87% used (five_hour); resets at ${new Date(1_800_000_000_000).toLocaleString()}`,
        ]);
        await pi.handlers.get("session_shutdown")[0]({}, {});
    }
    finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await rm(directory, { recursive: true, force: true });
    }
});

test("converts fractional weekly utilization to a percentage", async () => {
    const { directory, executable } = await createFakeClaude("ok", { rateLimitInfo: {
        status: "allowed_warning",
        rateLimitType: "seven_day",
        utilization: 0.861,
    } });
    const original = {
        executable: process.env.PI_CLAUDE_CODE_PROVIDER_PATH,
        metrics: process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG,
    };
    const metricsPath = join(directory, "metrics.jsonl");
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG = metricsPath;
    try {
        const pi = fakePi();
        await piClaudeCodeProvider(pi.api);
        const provider = pi.providers.get("pi-claude-code-provider");
        assert.ok(provider);
        const configured = provider.models.find((model) => model.id === "sonnet");
        const model = {
            ...configured,
            provider: "pi-claude-code-provider",
            api: "pi-claude-code-provider-headless",
            baseUrl: "pi-claude-code-provider://local",
        };
        const context = providerContext();
        const notices = [];
        pi.handlers.get("session_start")[0]({}, sessionContext(tmpdir(), { notify(message, level) { notices.push({ message, level }); } }));
        assert.equal((await provider.streamSimple(model, context, { reasoning: "medium" }).result()).stopReason, "stop");
        assert.deepEqual(notices.find(({ message }) => message.includes("rate limit warning")), {
            message: "[pi-claude-code-provider] Claude rate limit warning: 86% used (seven_day)",
            level: "warning",
        });
        await pi.handlers.get("session_shutdown")[0]({}, {});
    }
    finally {
        if (original.executable === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original.executable;
        if (original.metrics === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG;
        else process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG = original.metrics;
        await rm(directory, { recursive: true, force: true });
    }
});

test("failed preflight retains the doctor and reports one session error", async () => {
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = "/does/not/exist/claude";
    try {
        const pi = fakePi();
        await piClaudeCodeProvider(pi.api);
        assert.equal(pi.commands.has("pi-claude-code-provider-doctor"), true);
        assert.equal(pi.providers.size, 0);
        assert.equal(pi.tools.size, 0);
        const notices = [];
        const sessionStart = pi.handlers.get("session_start") ?? [];
        assert.equal(sessionStart.length, 1);
        sessionStart[0]({}, sessionContext(tmpdir(), { notify(message, level) { notices.push({ message, level }); } }));
        assert.equal(notices.length, 1);
        assert.equal(notices[0].level, "error");
        assert.match(notices[0].message, /^\[pi-claude-code-provider\]/);
        assert.match(notices[0].message, /unavailable.*pi-claude-code-provider-doctor.*reload/i);
        await pi.commands.get("pi-claude-code-provider-doctor").handler("report", { ui: { notify(message, level) { notices.push({ message, level }); } } });
        const reportPath = notices.at(-1).message.match(/written to (.*); preflight/)?.[1];
        assert.ok(reportPath);
        try {
            assert.equal(notices.at(-1).level, "warning");
            if (process.platform !== "win32") assert.equal((await stat(reportPath)).mode & 0o777, 0o600);
            assert.match(await readFile(reportPath, "utf8"), /"errorCode": "executable_missing"/);
        }
        finally {
            await rm(dirname(reportPath), { recursive: true, force: true });
        }
    }
    finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
    }
});

test("truncated web-search output is retained only for the session", async () => {
    const { directory, executable } = await createFakeClaude("x".repeat(60 * 1024));
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const existingWebSearch = { name: "web_search" };
        const pi = fakePi([existingWebSearch]);
        await piClaudeCodeProvider(pi.api);
        assert.equal(pi.providers.has("pi-claude-code-provider"), true);
        const notices = [];
        const sessionStart = pi.handlers.get("session_start") ?? [];
        assert.equal(sessionStart.length, 1);
        sessionStart[0]({}, sessionContext(tmpdir(), { notify(message, level) { notices.push({ message, level }); } }));
        assert.equal(pi.tools.get("web_search"), existingWebSearch);
        assert.equal(notices.some(({ message }) => /(?:Pi|Claude Code) .*unverified/.test(message)), false);
        assert.equal(notices.every(({ message }) => message.startsWith("[pi-claude-code-provider]")), true);
        const search = pi.tools.get("pi_claude_code_provider_web_search");
        assert.ok(search);
        assert.match(search.description, new RegExp(`${formatSize(DEFAULT_MAX_BYTES)} or ${DEFAULT_MAX_LINES} lines`));
        const result = await search.execute("call", { query: "query" }, undefined);
        assert.equal(result.details.truncated, true);
        assert.ok(result.details.fullOutputPath);
        await access(result.details.fullOutputPath);
        const shutdown = pi.handlers.get("session_shutdown") ?? [];
        assert.equal(shutdown.length, 1);
        await shutdown[0]({}, {});
        await assert.rejects(access(result.details.fullOutputPath));
    }
    finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await rm(directory, { recursive: true, force: true });
    }
});

test("web-search output finishing after shutdown is not retained", async () => {
    const { directory, executable } = await createFakeClaude("x".repeat(60 * 1024), { searchDelayMs: 50 });
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    const outputDirectories = async () => (await readdir(tmpdir(), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("pi-claude-code-provider-search-output-"))
        .map((entry) => entry.name)
        .sort();
    const before = await outputDirectories();
    try {
        const pi = fakePi();
        await piClaudeCodeProvider(pi.api);
        pi.handlers.get("session_start")[0]({}, sessionContext(tmpdir(), { notify() { } }));
        const search = pi.tools.get("pi_claude_code_provider_web_search");
        const pending = search.execute("call", { query: "query" }, undefined);
        await pi.handlers.get("session_shutdown")[0]({}, {});
        const result = await pending;
        assert.equal(result.details.truncated, true);
        assert.equal(result.details.fullOutputPath, undefined);
        assert.doesNotMatch(result.content[0].text, /Full output:/);
        const after = await outputDirectories();
        assert.deepEqual(after.filter((name) => !before.includes(name)), []);
    }
    finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await rm(directory, { recursive: true, force: true });
    }
});

test("an occupied permanent web-search name is preserved with a prefixed warning", async () => {
    const { directory, executable } = await createFakeClaude();
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const existingSearch = { name: "pi_claude_code_provider_web_search", owner: "other-extension" };
        const pi = fakePi([existingSearch]);
        await piClaudeCodeProvider(pi.api);
        const notices = [];
        const sessionStart = pi.handlers.get("session_start") ?? [];
        assert.equal(sessionStart.length, 1);
        sessionStart[0]({}, sessionContext(tmpdir(), { notify(message, level) { notices.push({ message, level }); } }));
        assert.equal(pi.tools.get("pi_claude_code_provider_web_search"), existingSearch);
        const collision = notices.find(({ message }) => message.includes("tool name is already occupied"));
        assert.ok(collision);
        assert.equal(collision.level, "warning");
        assert.match(collision.message, /^\[pi-claude-code-provider\]/);
        await pi.handlers.get("session_shutdown")[0]({}, {});
        const later = [];
        sessionStart[0]({}, sessionContext(tmpdir(), { notify(message, level) { later.push({ message, level }); } }));
        assert.equal(pi.tools.get("pi_claude_code_provider_web_search"), existingSearch);
        assert.equal(later.some(({ message }) => message.includes("tool name is already occupied")), false);
        await pi.handlers.get("session_shutdown")[0]({}, {});
    }
    finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await rm(directory, { recursive: true, force: true });
    }
});

test("an exhausted subscription window reaches Pi as a stop, not as a retryable throttle", async () => {
    const { directory, executable } = await createFakeClaude();
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const pi = fakePi();
        await piClaudeCodeProvider(pi.api);
        const handler = pi.handlers.get("message_end")[0];
        const limited = {
            role: "assistant",
            provider: "pi-claude-code-provider",
            stopReason: "error",
            errorMessage: "Claude Code request failed (429): You've hit your session limit · resets 3:50am (America/Sao_Paulo)",
        };
        // Pi restarts a turn whose failure text looks like a transient 429, which
        // spends one Claude launch per attempt and cannot succeed until the window
        // resets. The quota marker is what makes Pi stop instead.
        const rewritten = handler({ message: limited }, {});
        assert.equal(rewritten.message.errorMessage, `quota exceeded: ${limited.errorMessage}`);
        assert.equal(handler({ message: rewritten.message }, {}), undefined);
        // A transient failure keeps its retryable wording, and another provider's
        // message is never rewritten at all.
        assert.equal(handler({ message: { ...limited, errorMessage: "Claude Code request failed (529): overloaded" } }, {}), undefined);
        assert.equal(handler({ message: { ...limited, provider: "anthropic" } }, { model: { provider: "anthropic" } }), undefined);
        assert.equal(handler({ message: { ...limited, stopReason: "stop" } }, {}), undefined);
    }
    finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await rm(directory, { recursive: true, force: true });
    }
});

test("provider requests run Claude in the current Pi session's directory, never the host process cwd", async () => {
    const { directory, executable } = await createFakeClaude("ok", { reportCwd: true });
    const sessionB = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-session-b-"));
    const sessionC = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-session-c-"));
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const pi = fakePi();
        await piClaudeCodeProvider(pi.api);
        const provider = pi.providers.get("pi-claude-code-provider");
        const configured = provider.models.find((model) => model.id === "sonnet");
        const model = {
            ...configured,
            provider: "pi-claude-code-provider",
            api: "pi-claude-code-provider-headless",
            baseUrl: "pi-claude-code-provider://local",
        };
        const context = providerContext();
        const request = () => provider.streamSimple(model, context, { reasoning: "medium" }).result();
        const childCwd = async () => {
            const result = await request();
            assert.equal(result.stopReason, "stop", result.errorMessage);
            return result.content.find((block) => block.type === "text")?.text;
        };
        const ui = { notify() { } };
        // A resumed or imported session takes its cwd from the session file, so
        // the host process cwd is the wrong directory to report to Claude.
        assert.notEqual(await realpath(sessionB), await realpath(process.cwd()));
        pi.handlers.get("session_start")[0]({}, sessionContext(sessionB, ui));
        assert.equal(await realpath(await childCwd()), await realpath(sessionB));
        await pi.handlers.get("session_shutdown")[0]({}, {});
        const afterShutdown = await request();
        assert.equal(afterShutdown.stopReason, "error");
        assert.match(afterShutdown.errorMessage ?? "", /session working directory is not available/);
        pi.handlers.get("session_start")[0]({}, sessionContext(sessionC, ui));
        assert.equal(await realpath(await childCwd()), await realpath(sessionC));
        await pi.handlers.get("session_shutdown")[0]({}, {});
    }
    finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await Promise.all([directory, sessionB, sessionC].map((path) => rm(path, { recursive: true, force: true })));
    }
});

test("parallel sessions each run in their own directory and survive each other's shutdown", async () => {
    // A Pi host can hold several sessions in one process, and re-runs this factory
    // for each new, resumed, forked or cloned one. Pi's own model runtime keeps
    // only the last registered streamSimple, so every request has to resolve the
    // session it actually belongs to.
    const { directory, executable } = await createFakeClaude("ok", { reportCwd: true });
    const childA = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-child-a-"));
    const childB = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-child-b-"));
    const worktree = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-worktree-"));
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const start = async (cwd) => {
            const pi = fakePi();
            await piClaudeCodeProvider(pi.api);
            const ctx = sessionContext(cwd, { notify() { } });
            pi.handlers.get("session_start")[0]({}, ctx);
            const provider = pi.providers.get("pi-claude-code-provider");
            const configured = provider.models.find((model) => model.id === "sonnet");
            return {
                sessionId: ctx.sessionManager.getSessionId(),
                shutdown: () => pi.handlers.get("session_shutdown")[0]({}, {}),
                // The last instance to register owns Pi's streamSimple, so every
                // request below deliberately goes through instance B's.
                stream: provider.streamSimple,
                model: {
                    ...configured,
                    provider: "pi-claude-code-provider",
                    api: "pi-claude-code-provider-headless",
                    baseUrl: "pi-claude-code-provider://local",
                },
            };
        };
        const context = (systemPrompt) => providerContext(systemPrompt ? { systemPrompt } : {});
        const a = await start(childA);
        const b = await start(childB);
        const run = async (sessionId, systemPrompt) => {
            const result = await b.stream(b.model, context(systemPrompt), { reasoning: "medium", sessionId }).result();
            return result.stopReason === "stop"
                ? await realpath(result.content.find((block) => block.type === "text")?.text)
                : result.errorMessage;
        };

        // Each child's own requests reach its own directory, not the last one registered.
        assert.equal(await run(a.sessionId), await realpath(childA));
        assert.equal(await run(b.sessionId), await realpath(childB));
        // A child Pi never started here, carrying the directory it works in.
        assert.equal(await run("foreground-child", `Pi.

Current working directory: ${worktree}`), await realpath(worktree));
        // Pi's compaction one-shot: a fresh id, no tools, no stated directory.
        assert.equal(await run("01a0-fresh-compaction"), await realpath(childB));
        // The same unknown id with tools is refused rather than guessed.
        const guessed = await b.stream(b.model, providerContext({ tools: [{ name: "read", description: "read", parameters: { type: "object" } }] }), { reasoning: "medium", sessionId: "01a0-fresh-compaction" }).result();
        assert.equal(guessed.stopReason, "error");
        assert.match(guessed.errorMessage ?? "", /no registered session or recognized working directory.*2 sessions are live/);
        // The payload hook can add tools after the initial tool-free routing
        // decision. That must not turn a borrowed summary cwd into a tool cwd.
        const addedByHook = await b.stream(b.model, context(), {
            reasoning: "medium",
            sessionId: "01a0-fresh-compaction",
            onPayload: (payload) => ({ ...payload, tools: [{ name: "read", description: "read", parameters: { type: "object" } }] }),
        }).result();
        assert.equal(addedByHook.stopReason, "error");
        assert.match(addedByHook.errorMessage ?? "", /gained tools after before_provider_request/);

        // A surviving child keeps working, including its image store, after the
        // session that registered the provider last has gone.
        await b.shutdown();
        assert.equal(await run(a.sessionId), await realpath(childA));
        await a.shutdown();
        assert.match(await run(a.sessionId), /session working directory is not available/);
    }
    finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await Promise.all([directory, childA, childB, worktree].map((path) => rm(path, { recursive: true, force: true })));
    }
});

function providerModel(provider) {
    const configured = provider.models.find((model) => model.id === "sonnet");
    return {
        ...configured,
        provider: "pi-claude-code-provider",
        api: "pi-claude-code-provider-headless",
        baseUrl: "pi-claude-code-provider://local",
    };
}

test("Pi binding one session twice is not an error", async () => {
    // Pi's RPC runtime rebinds extensions for a new, resumed, forked or cloned
    // session and its command handler then rebinds again, so session_start arrives
    // twice with no shutdown between. Every step of the handler has to be
    // idempotent: refusing the second bind reported an extension error to the
    // client on every one of those transitions.
    const { directory, executable } = await createFakeClaude("ok", { reportCwd: true });
    const firstCwd = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-bind-a-"));
    const secondCwd = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-bind-b-"));
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const pi = fakePi();
        await piClaudeCodeProvider(pi.api);
        const sessionStart = pi.handlers.get("session_start")[0];
        const first = sessionContext(firstCwd, { notify() { } });
        sessionStart({}, first);
        // The same session bound again: the id and the directory repeat.
        sessionStart({}, first);
        assert.deepEqual([...sessionRegistry().keys()], [first.sessionManager.getSessionId()]);
        // A replacement session on the same instance, also bound twice. The earlier
        // id must not be left behind beside it.
        const second = sessionContext(secondCwd, { notify() { } });
        sessionStart({}, second);
        sessionStart({}, second);
        assert.deepEqual([...sessionRegistry().keys()], [second.sessionManager.getSessionId()]);
        const provider = pi.providers.get("pi-claude-code-provider");
        const result = await provider.streamSimple(
            providerModel(provider),
            providerContext(),
            { reasoning: "medium", sessionId: second.sessionManager.getSessionId() },
        ).result();
        assert.equal(result.stopReason, "stop", result.errorMessage);
        assert.equal(
            await realpath(result.content.find((block) => block.type === "text")?.text),
            await realpath(secondCwd),
        );
        await pi.handlers.get("session_shutdown")[0]({}, {});
        assert.deepEqual([...sessionRegistry().keys()], []);
    }
    finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await Promise.all([directory, firstCwd, secondCwd].map((path) => rm(path, { recursive: true, force: true })));
    }
});

test("session shutdown does not wait for a request Pi has not cancelled yet", async () => {
    // Pi emits session_shutdown before it stops the turn, and awaits the handler
    // with no timeout, so waiting for an image-store lease held Pi open until
    // Claude finished answering. Shutdown leaves the directory to the request still
    // writing to it, and that request reclaims it when it finishes.
    const { directory, executable } = await createFakeClaude("ok", { searchDelayMs: 300 });
    const sessionCwd = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-quit-"));
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    const imageDirectories = async () => (await readdir(tmpdir(), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("pi-claude-code-provider-images-"))
        .map((entry) => entry.name)
        .sort();
    const before = await imageDirectories();
    let retained;
    try {
        const pi = fakePi();
        await piClaudeCodeProvider(pi.api);
        const ctx = sessionContext(sessionCwd, { notify() { } });
        pi.handlers.get("session_start")[0]({}, ctx);
        const provider = pi.providers.get("pi-claude-code-provider");
        const context = providerContext({
            messages: [{
                role: "user",
                content: [
                    { type: "text", text: "describe this" },
                    { type: "image", data: Buffer.from("provider image bytes").toString("base64"), mimeType: "image/png" },
                ],
                timestamp: 1,
            }],
        });
        let settled = false;
        const pending = provider
            .streamSimple(providerModel(provider), context, { reasoning: "medium", sessionId: ctx.sessionManager.getSessionId() })
            .result()
            .then((result) => { settled = true; return result; });
        // Wait for the image to be stored, so a lease is certainly held and there is
        // a directory whose retention can be observed.
        for (let attempt = 0; attempt < 300 && (await imageDirectories()).length === before.length; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const opened = (await imageDirectories()).filter((name) => !before.includes(name));
        assert.equal(opened.length, 1, "the request never opened the session image store");
        retained = join(tmpdir(), opened[0]);
        await pi.handlers.get("session_shutdown")[0]({}, {});
        assert.equal(settled, false, "session shutdown waited for the in-flight request");
        // Retained rather than removed, because the request can still write to it.
        await access(retained);
        const result = await pending;
        assert.equal(result.stopReason, "stop", result.errorMessage);
        // The request that held the lease reclaims the directory once it finishes.
        // Nothing else can: session_shutdown has already run, and on Windows there
        // is no stale-state pass to fall back on. release() does not await the
        // removal, so poll for it.
        for (let attempt = 0; attempt < 300 && (await imageDirectories()).includes(opened[0]); attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await assert.rejects(access(retained), "the session image directory was never reclaimed");
    }
    finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await Promise.all([directory, sessionCwd, ...(retained ? [retained] : [])]
            .map((path) => rm(path, { recursive: true, force: true })));
    }
});

test("serves Pi-AI API-registry calls, which an extension's own agent loop makes", async () => {
    // pi.registerProvider populates Pi's model runtime only. completeSimple and
    // agentLoop's default stream function resolve the model's api in Pi-AI's
    // registry, where a miss throws into an unawaited loop and exits Pi.
    const { directory, executable } = await createFakeClaude("side-request-ok");
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const pi = fakePi();
        await piClaudeCodeProvider(pi.api);
        assert.ok(getApiProvider("pi-claude-code-provider-headless"), "registered when the extension loads");
        const provider = pi.providers.get("pi-claude-code-provider");
        const configured = provider.models.find((model) => model.id === "sonnet");
        const model = {
            ...configured,
            provider: "pi-claude-code-provider",
            api: "pi-claude-code-provider-headless",
            baseUrl: "pi-claude-code-provider://local",
        };
        // A second instance shares the registration rather than replacing it.
        const other = fakePi();
        await piClaudeCodeProvider(other.api);
        pi.handlers.get("session_start")[0]({}, sessionContext(tmpdir(), { notify() { } }));

        // A side request is an ordinary request: no session id of its own, no tools.
        const answer = await completeSimple(model, { messages: [{ role: "user", content: "ping", timestamp: 1 }] }, { reasoning: "medium" });
        assert.equal(answer.stopReason, "stop", answer.errorMessage);
        assert.equal(answer.content.find((block) => block.type === "text")?.text, "side-request-ok");

        // Another session's /reload clears the registry for every extension in
        // the process, so the next session start re-asserts ownership.
        resetApiProviders();
        assert.equal(getApiProvider("pi-claude-code-provider-headless"), undefined);
        other.handlers.get("session_start")[0]({}, sessionContext(tmpdir(), { notify() { } }));
        assert.ok(getApiProvider("pi-claude-code-provider-headless"));

        // The instance that registered leaving must not strip the registration
        // the other one is still being served by.
        await pi.handlers.get("session_shutdown")[0]({}, {});
        assert.ok(getApiProvider("pi-claude-code-provider-headless"));
        await other.handlers.get("session_shutdown")[0]({}, {});
        assert.equal(getApiProvider("pi-claude-code-provider-headless"), undefined);
    }
    finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        unregisterApiProviders("pi-claude-code-provider");
        await rm(directory, { recursive: true, force: true });
    }
});

test("a Pi without Pi-AI's compat entrypoint still gets the provider", async () => {
    // That entrypoint is temporary by its own declaration. A static import of it
    // would fail resolution before the factory runs, so the extension would not
    // load at all and even its unavailable notice would never report; losing it
    // must cost only side requests from other extensions.
    const { directory, executable } = await createFakeClaude();
    try {
        const { stdout } = await promisify(execFile)(
            process.execPath,
            [fileURLToPath(new URL("../support/extension-without-compat.js", import.meta.url))],
            { env: { ...process.env, PI_CLAUDE_CODE_PROVIDER_PATH: executable } },
        );
        assert.equal(stdout.trim(), "ok");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("Pi resolves the package to its index entry, which re-exports the implementation", async () => {
    // An index entry keeps Pi's startup extension label to the bare package name.
    const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-agent-"));
    try {
        const packageManager = new DefaultPackageManager({ cwd: packageRoot, agentDir, settingsManager: SettingsManager.inMemory() });
        const resolved = await packageManager.resolveExtensionSources([packageRoot], { temporary: true });
        assert.deepEqual(resolved.extensions.map((extension) => extension.path), [join(packageRoot, "extensions", "index.ts")]);
        assert.equal(initializePiClaudeCodeProvider, implementation);
    } finally {
        await rm(agentDir, { recursive: true, force: true });
    }
});
