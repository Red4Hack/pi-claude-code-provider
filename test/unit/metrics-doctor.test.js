import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { platformStatus, versionStatus } from "../../src/compatibility.ts";
import { writeDiagnosticReport } from "../../src/diagnostics.ts";
import { bridgeArgv, formatBridgeArgv } from "../../src/claude-args.ts";
import { formatDoctorSummary, probeBridge } from "../../src/doctor.ts";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { cleanupStaleRuntimeDirectories } from "../../src/runtime-directories.ts";
import { ClaudeCodeError } from "../../src/errors.ts";
import { appendRequestMetrics, appendSearchMetrics, flushMetricsLog, getLastRequestMetrics, getMetricsLogError, recordRequestMetrics, recordSearchMetrics, serializeRequestMetrics, serializeSearchMetrics } from "../../src/metrics.ts";
import { CAPTURED_CLAUDE_VERSION } from "../support/claude-fixture.js";

const metrics = {
    schemaVersion: 5, timestamp: "2026-07-12T00:00:00.000Z", platform: "linux", architecture: "x64", nodeVersion: "v24.16.0", claudeVersion: CAPTURED_CLAUDE_VERSION, requestedModel: "sonnet", resolvedModel: "claude-sonnet-5", effort: "medium",
    messageCount: 2, toolCount: 1, imageCount: 0, transcriptBytes: 100, catalogBytes: 50, imageBytes: 0, estimatedInputTokens: 1000,
    servedContextWindow: 1000000, servedMaxOutputTokens: 64000, cacheRead: 10, cacheWrite: 20, inputTokens: 30, outputTokens: 2,
    cacheHitPercent: 16.67, durationMs: 250, lastPhase: "completed", cleanupComplete: true, stopReason: "stop", exitCode: 0, exitSignal: null, terminationExpected: false,
};
test("metrics serialization is content-free, appendable, and mode 0600", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-metrics-"));
    const path = join(directory, "metrics.jsonl");
    try {
        assert.doesNotMatch(serializeRequestMetrics(metrics), /prompt|secret|pi-claude-code-provider-/i);
        await appendRequestMetrics(path, metrics);
        await chmod(path, 0o644);
        await appendRequestMetrics(path, { ...metrics, stopReason: "error", errorCategory: "protocol" });
        const lines = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
        assert.equal(lines.length, 2);
        assert.equal(lines[0].schemaVersion, 5);
        assert.equal(lines[0].terminationExpected, false);
        assert.equal(lines[1].errorCategory, "protocol");
        if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
});
test("web-search metrics append a discriminated content-free record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-search-metrics-"));
    const path = join(directory, "metrics.jsonl");
    const search = { schemaVersion: 1, timestamp: metrics.timestamp, platform: "linux", architecture: "x64", nodeVersion: process.version, claudeVersion: CAPTURED_CLAUDE_VERSION, requestBytes: 12, capturedBytes: 34, resultBytes: 56, durationMs: 78, lastPhase: "completed", initialized: true, cleanupComplete: true, exitCode: 0, exitSignal: null };
    try {
        assert.doesNotMatch(serializeSearchMetrics(search), /query|result text|secret/i);
        await appendSearchMetrics(path, search);
        const record = JSON.parse((await readFile(path, "utf8")).trim());
        assert.equal(record.kind, "web_search");
        assert.equal(record.requestBytes, 12);
        if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
});
test("recording web-search metrics honors the configured private log", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-record-search-metrics-"));
    const path = join(directory, "metrics.jsonl");
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG;
    const search = { schemaVersion: 1, timestamp: metrics.timestamp, platform: "linux", architecture: "x64", nodeVersion: process.version, claudeVersion: CAPTURED_CLAUDE_VERSION, requestBytes: 1, capturedBytes: 2, resultBytes: 3, durationMs: 4, lastPhase: "completed", initialized: true, cleanupComplete: true };
    process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG = path;
    try {
        recordSearchMetrics(search);
        await flushMetricsLog();
        assert.equal(JSON.parse(await readFile(path, "utf8")).kind, "web_search");
    }
    finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG;
        else process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG = original;
        await rm(directory, { recursive: true, force: true });
    }
});
test("metrics flush serializes every queued provider and search record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-flush-metrics-"));
    const path = join(directory, "metrics.jsonl");
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG;
    const search = { schemaVersion: 1, timestamp: metrics.timestamp, platform: "linux", architecture: "x64", nodeVersion: process.version, claudeVersion: CAPTURED_CLAUDE_VERSION, requestBytes: 1, capturedBytes: 2, resultBytes: 3, durationMs: 4, lastPhase: "completed", initialized: true, cleanupComplete: true };
    process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG = path;
    try {
        recordRequestMetrics(metrics);
        recordSearchMetrics(search);
        recordRequestMetrics({ ...metrics, requestedModel: "haiku" });
        await flushMetricsLog();
        const lines = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
        assert.equal(lines.length, 3);
        assert.equal(lines[0].requestedModel, "sonnet");
        assert.equal(lines[1].kind, "web_search");
        assert.equal(lines[2].requestedModel, "haiku");
        if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
    finally {
        await flushMetricsLog();
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG;
        else process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG = original;
        await rm(directory, { recursive: true, force: true });
    }
});
test("last metrics are defensively cloned", () => {
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG;
    delete process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG;
    try {
        recordRequestMetrics(metrics);
        const first = getLastRequestMetrics();
        first.cacheRead = 999;
        assert.equal(getLastRequestMetrics().cacheRead, 10);
    }
    finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG;
        else process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG = original;
    }
});
test("metrics logging exposes only a sanitized latest failure", async () => {
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG;
    process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG = join(tmpdir(), "pi-claude-code-provider-missing-directory", "metrics.jsonl");
    try {
        recordRequestMetrics(metrics);
        await flushMetricsLog();
        assert.equal(getMetricsLogError(), "ENOENT");
        assert.doesNotMatch(getMetricsLogError(), /tmp|metrics\.jsonl/);
        delete process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG;
        recordRequestMetrics(metrics);
        assert.equal(getMetricsLogError(), undefined);
    }
    finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG;
        else process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG = original;
    }
});
function doctorBase() {
    return { platformStatus: platformStatus("linux", "x64"), piStatus: versionStatus("Pi", "1", "1"), claudeStatus: versionStatus("Claude Code", "2", "1"), installation: { executable: "/usr/bin/claude", version: "2", subscriptionType: "pro" }, modelIds: ["sonnet"], runtimeCleanup: { removed: 0, failures: 0, reaped: 0 } };
}
test("doctor names the model each alias would be served, or says it cannot", () => {
    const base = { ...doctorBase(), modelIds: ["sonnet", "fable", "opus", "haiku"] };
    // No map at all: the doctor stays exactly as it was before the scan existed.
    assert.doesNotMatch(formatDoctorSummary(base), /Claude Code install/);
    const versions = { sonnet: "claude-sonnet-5", fable: "claude-fable-5-1", opus: "claude-opus-5", haiku: "claude-haiku-4-5" };
    const pro = formatDoctorSummary({ ...base, modelVersions: versions });
    assert.match(pro, /^Served models \(Claude Code install\): sonnet claude-sonnet-5, fable claude-fable-5-1 \(Pro: requires usage credits enabled\), opus claude-opus-5, haiku claude-haiku-4-5$/m);
    // The caveat is about entitlement, not detection: auth status exposes no
    // credit field, so the wording must not claim to know either way.
    assert.doesNotMatch(pro, /credits (?:are|enabled and|disabled)/);
    const max = formatDoctorSummary({ ...base, installation: { ...base.installation, subscriptionType: "max" }, modelVersions: versions });
    assert.doesNotMatch(max, /requires usage credits/);
    // A missing alias is reported as unavailable rather than omitted silently.
    assert.match(formatDoctorSummary({ ...base, modelVersions: { sonnet: "claude-sonnet-5" } }), /sonnet claude-sonnet-5, fable unavailable, opus unavailable, haiku unavailable/);
    assert.match(formatDoctorSummary({ ...base, modelVersions: {} }), /sonnet unavailable/);
});

test("doctor summary handles absent, successful, and failed request diagnostics", () => {
    const base = { platformStatus: platformStatus("linux", "x64"), piStatus: versionStatus("Pi", "1", "1"), claudeStatus: versionStatus("Claude Code", "2", "1"), installation: { executable: "/usr/bin/claude", version: "2", subscriptionType: "pro" }, modelIds: ["sonnet"], runtimeCleanup: { removed: 0, failures: 0, reaped: 0 } };
    assert.match(formatDoctorSummary(base), /no request metrics recorded/);
    assert.match(formatDoctorSummary({ ...base, metrics }), /1000 estimated transport tokens.*30 input, 10 cache read, 20 cache write, 16\.67% cache hit.*250ms.*stop/);
    assert.match(formatDoctorSummary({ ...base, metrics: { ...metrics, cacheRead: 0, cacheWrite: 0, cacheHitPercent: 0 } }), /30 input, 0 cache read, 0 cache write, 0% cache hit/);
    assert.match(formatDoctorSummary({ ...base, metrics: { ...metrics, inputTokens: 0, cacheRead: 0, cacheWrite: 0, cacheHitPercent: undefined } }), /reported token usage unavailable/);
    const failed = formatDoctorSummary({ ...base, metrics: { ...metrics, stopReason: "error", errorCategory: "protocol" } });
    assert.match(failed, /error \(protocol\)/);
    assert.match(formatDoctorSummary({ ...base, metricsLogError: "EACCES" }), /^Metrics log error: EACCES$/m);
    assert.match(formatDoctorSummary({ ...base, runtimeCleanup: { removed: 2, failures: 1, reaped: 0 } }), /^Stale runtime cleanup: 2 removed, 1 failure$/m);
    // An abandoned Claude process group that outlived its Pi host is reported on
    // its own: it explains both a reclaimed machine and a spent subscription slot.
    assert.match(formatDoctorSummary({ ...base, runtimeCleanup: { removed: 1, failures: 0, reaped: 1 } }), /^Stale runtime cleanup: 1 removed, 1 abandoned Claude process terminated, 0 failures$/m);
    assert.match(formatDoctorSummary({ ...base, metrics: { ...metrics, cleanupComplete: false, errorCategory: "process_cleanup" } }), /process_cleanup.*cleanup incomplete/);
    assert.doesNotMatch(failed, /prompt|secret|pi-claude-code-provider-/i);
});

test("doctor identifies each working-directory source without logging the path", () => {
    const sources = {
        registered: "registered Pi session",
        prompt: "Pi prompt declaration",
        single: "sole-session compatibility borrow",
        oneshot: "tool-free newest-session borrow",
    };
    for (const [resolution, description] of Object.entries(sources)) {
        const summary = formatDoctorSummary({ ...doctorBase(), metrics: { ...metrics, sessionResolution: resolution } });
        assert.match(summary, new RegExp(`^Working directory source: ${description}$`, "m"));
    }
    assert.match(formatDoctorSummary({ ...doctorBase(), metrics }), /^Working directory source: unresolved$/m);
});

test("doctor summary puts one labeled fact on each line", () => {
    const lines = formatDoctorSummary({ ...doctorBase(), metrics, metricsLogError: "EACCES" }).split("\n");
    assert.equal(lines[0], "Platform linux/x64 (verified); Pi 1 (verified); Claude Code 2 (unverified; tested 1)");
    assert.deepEqual(lines.slice(1).map((line) => line.slice(0, line.indexOf(":"))), ["Runtime", "Claude", "Models", "Last request", "Working directory source", "Metrics log error"]);
    assert.equal(lines[2], "Claude: /usr/bin/claude (pro subscription)");
});

test("doctor reports a served context window only once it stops matching the configured one", () => {
    // The budget checks bound a request against the configured window, so a
    // smaller served one makes them too permissive. The fixture's sonnet on Pro
    // configures 1M, which the paid matrix has verified, so a match stays silent.
    const base = doctorBase();
    assert.doesNotMatch(formatDoctorSummary({ ...base, metrics }), /Context window:/);
    const drifted = formatDoctorSummary({ ...base, metrics: { ...metrics, servedContextWindow: 200000 } });
    assert.match(drifted, /^Context window: sonnet served 200000, configured 1000000; request budget checks use the configured value$/m);
    // A larger served window is still a mismatch worth stating; only equality is silent.
    assert.match(formatDoctorSummary({ ...base, metrics: { ...metrics, requestedModel: "haiku", servedContextWindow: 1000000 } }), /haiku served 1000000, configured 200000/);
    // Nothing to compare against is not a finding.
    assert.doesNotMatch(formatDoctorSummary({ ...base, metrics: { ...metrics, servedContextWindow: undefined } }), /Context window:/);
    assert.doesNotMatch(formatDoctorSummary({ ...base, metrics: { ...metrics, requestedModel: "unknown-alias" } }), /Context window:/);
});

test("doctor reports collapsed prompt-cache reuse, and stays quiet where reuse proves nothing", () => {
    // Losing reuse is otherwise silent, so the doctor is the only place it shows.
    const base = doctorBase();
    const cold = { ...metrics, messageCount: 8, estimatedInputTokens: 50000, cacheHitPercent: 0 };
    const reported = formatDoctorSummary({ ...base, metrics: cold });
    assert.match(reported, /^Prompt cache: last request reused 0% over 8 messages\./m);
    // The wording must not let one reading stand as a diagnosis.
    assert.match(reported, /One low reading is not evidence/);
    assert.match(reported, /summary requests never reuse/);
    // Each condition alone suppresses it: healthy reuse, a first turn with no
    // prefix to reuse, a request too small for any model to cache, and usage
    // Claude never reported.
    assert.doesNotMatch(formatDoctorSummary({ ...base, metrics: { ...cold, cacheHitPercent: 97 } }), /Prompt cache:/);
    assert.doesNotMatch(formatDoctorSummary({ ...base, metrics: { ...cold, messageCount: 1 } }), /Prompt cache:/);
    assert.doesNotMatch(formatDoctorSummary({ ...base, metrics: { ...cold, estimatedInputTokens: 500 } }), /Prompt cache:/);
    assert.doesNotMatch(formatDoctorSummary({ ...base, metrics: { ...cold, cacheHitPercent: undefined } }), /Prompt cache:/);
    // The fixture request is far below the cacheable floor, so the ordinary
    // summary gains no line at all.
    assert.doesNotMatch(formatDoctorSummary({ ...base, metrics }), /Prompt cache:/);
});

test("the diagnostic report records whether the transcript breakpoint is disabled", async () => {
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_TRANSCRIPT_BREAKPOINT;
    process.env.PI_CLAUDE_CODE_PROVIDER_TRANSCRIPT_BREAKPOINT = "off";
    let path;
    try {
        path = await writeDiagnosticReport(doctorBase());
        assert.equal(JSON.parse(await readFile(path, "utf8")).overrides.transcriptBreakpointDisabled, true);
    }
    finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_TRANSCRIPT_BREAKPOINT;
        else process.env.PI_CLAUDE_CODE_PROVIDER_TRANSCRIPT_BREAKPOINT = original;
        if (path) await rm(dirname(path), { recursive: true, force: true });
    }
});

test("diagnostic reports are bounded, private, redacted, and content-free", async () => {
    const path = await writeDiagnosticReport({
        platformStatus: platformStatus("darwin", "arm64"),
        piStatus: versionStatus("Pi", "1", "1"),
        preflightError: new ClaudeCodeError("executable_missing", `Claude missing below ${homedir()}`),
        metrics,
        runtimeCleanup: { removed: 2, failures: 1, reaped: 0 },
    });
    try {
        if (process.platform !== "win32") {
            assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
            assert.equal((await stat(path)).mode & 0o777, 0o600);
        }
        const contents = await readFile(path, "utf8");
        assert.ok(Buffer.byteLength(contents) < 64 * 1024);
        assert.match(contents, /pi-claude-code-provider-diagnostics-v2/);
        assert.match(contents, /<HOME>/);
        assert.match(contents, /"runtimeCleanup"/);
        assert.match(contents, /"removed": 2/);
        assert.match(contents, /"failures": 1/);
        assert.doesNotMatch(contents, new RegExp(homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.doesNotMatch(contents, /prompt|query|stderr|private@example/i);
    }
    finally {
        await rm(dirname(path), { recursive: true, force: true });
    }
});

test("the doctor completes a real bridge handshake under the hosting runtime", async () => {
    const probe = await probeBridge();
    assert.equal(probe.ok, true, probe.detail);
    assert.deepEqual(probe.argv, bridgeArgv());
    assert.match(probe.detail, /1 tool listed, ready marker written/);
    // A version or path check passes on an install whose bridge can never start,
    // so the summary must surface the handshake result and the resolved command.
    const summary = formatDoctorSummary({ ...doctorBase(), bridgeProbe: probe });
    assert.match(summary, /^Bridge: ok via /m);
    assert.match(summary, new RegExp(`^Runtime: ${process.versions.bun ? "Bun" : "Node"} `, "m"));
    const broken = formatDoctorSummary({
        ...doctorBase(),
        bridgeProbe: { ok: false, argv: probe.argv, detail: "handshake failed (no tools/list result, ready marker missing)" },
    });
    assert.match(broken, /^Bridge: BROKEN via .*ready marker missing\)\)$/m);
});

function fakeProbe(root, { code = 0, waitError, terminationError } = {}) {
    return {
        temporaryRoot: root,
        spawnChild(_command, _args, options) {
            const stdout = new EventEmitter();
            return {
                pid: 424242,
                stdout,
                stderr: new EventEmitter(),
                stdin: {
                    end() {
                        stdout.emit("data", Buffer.from('{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"probe"}]}}\n'));
                        writeFileSync(options.env.PI_CLAUDE_TOOL_READY, "ready");
                    },
                },
            };
        },
        supervise(_child, options) {
            return {
                touch() {},
                dispose() {},
                async wait() {
                    if (waitError) {
                        options.onFailure(waitError);
                        throw waitError;
                    }
                    return { code, signal: null };
                },
                async terminate() {
                    if (terminationError) throw terminationError;
                },
            };
        },
    };
}

test("doctor rejects nonzero bridge exit and timeout even after a valid handshake", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-doctor-failures-"));
    try {
        const nonzero = await probeBridge(1000, fakeProbe(root, { code: 7 }));
        assert.equal(nonzero.ok, false);
        assert.match(nonzero.detail, /exit code 7/);
        const timeout = await probeBridge(1000, fakeProbe(root, { waitError: new Error("probe timed out") }));
        assert.equal(timeout.ok, false);
        assert.match(timeout.detail, /probe timed out/);
        assert.deepEqual(await readdir(root), []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("doctor reports uncertain termination and retains marked state until stale recovery proves the child gone", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-doctor-retained-"));
    try {
        const probe = await probeBridge(1000, fakeProbe(root, { terminationError: new Error("synthetic EPERM") }));
        assert.equal(probe.ok, false);
        assert.match(probe.detail, /cleanup failed; liveness unknown/);
        const [name] = await readdir(root);
        assert.match(name, /^pi-claude-code-provider-bridge-probe-/);
        const directory = join(root, name);
        const marker = JSON.parse(await readFile(join(directory, ".pi-claude-code-provider-runtime.json"), "utf8"));
        assert.equal(marker.childPid, 424242);
        const options = { temporaryRoot: root, currentUid: (await stat(root)).uid, minimumAgeMs: 0, now: Date.now() + 1000 };
        assert.deepEqual(await cleanupStaleRuntimeDirectories({ ...options, processAlive: (pid) => pid === -424242 }), { removed: 0, failures: 0, reaped: 0 });
        assert.deepEqual(await cleanupStaleRuntimeDirectories({ ...options, processAlive: () => false }), { removed: 1, failures: 0, reaped: 0 });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("the diagnostic report records the distribution that decides bridge launching", async () => {
    const path = await writeDiagnosticReport({
        ...doctorBase(),
        bridgeProbe: { ok: false, argv: bridgeArgv(), detail: "handshake failed" },
    });
    try {
        const report = JSON.parse(await readFile(path, "utf8"));
        assert.equal(report.system.bunVersion, process.versions.bun);
        assert.match(report.system.hostRuntime, /^(Node|Bun) \S+ at /);
        assert.equal(report.bridge.ok, false);
        assert.ok(Array.isArray(report.bridge.argv));
        assert.match(report.bridge.detail, /handshake failed/);
        assert.doesNotMatch(JSON.stringify(report), new RegExp(homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
        await rm(dirname(path), { recursive: true, force: true });
    }
});

test("bridge argv diagnostics preserve argument boundaries", () => {
    const argv = ["/runtime with space/pi", "--config=/private config/bunfig.toml", "/package path/bridge.js"];
    assert.deepEqual(JSON.parse(formatBridgeArgv(argv)), argv);
    const summary = formatDoctorSummary({
        ...doctorBase(),
        bridgeProbe: { ok: false, argv, detail: "handshake failed" },
    });
    assert.ok(summary.includes(formatBridgeArgv(argv)));
});
