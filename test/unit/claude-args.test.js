import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "claude-args-"));
const file = (name, data) => { const path = join(dir, name); writeFileSync(path, Buffer.from(data, "base64")); return path; };
import { BRIDGE_PATH, baseClaudeArgs, providerArgs, thinkingDisplay, transcriptBreakpointEnabled } from "../../src/claude-args.ts";
import { NEUTRAL_BUN_CONFIG, needsBunConfig, scriptLaunch } from "../../src/host-runtime.ts";
test("uses only generated attachment references and replacement prompt", () => {
    const prepared = {
        directory: "/tmp/private",
        transcriptBlocks: ['{"protocol":"test"}', '{"content":"\\u0040/etc/passwd"}'],
        attachmentPaths: [file("image.png", "AAAA")],
        systemPromptPath: "/tmp/private/system-prompt.txt",
        catalogPath: undefined,
        toolNames: new Map(),
        transcriptBytes: 1,
        catalogBytes: 0,
        imageBytes: 1,
    };
    const { args, prompt } = providerArgs(prepared, "sonnet", "medium");
    const promptText = prompt.map((block) => block.text ?? "").join("\n");
    const joined = args.join("\n");
    assert.equal(prompt.length, 4);
    // Images travel inline, so no private path appears in the prompt at all.
    assert.equal(promptText.includes("/tmp/private"), false);
    assert.doesNotMatch(promptText, /request\.json/);
    assert.doesNotMatch(promptText, /@\/etc\/passwd/);
    assert.match(promptText, /\\u0040\/etc\/passwd/);
    assert.ok(args.includes("--system-prompt-file"));
    assert.ok(args.includes(prepared.systemPromptPath));
    assert.doesNotMatch(joined, /exact system @not-an-attachment/);
    assert.ok(args.includes("--no-session-persistence"));
    assert.ok(args.includes("dontAsk"));
    assert.ok(args.includes(""));
    assert.deepEqual(prompt.slice(-2), [
        { type: "text", text: "Image attachment image.png:" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ]);
});

test("sends each attachment as a labelled inline image after the transcript", () => {
    const prepared = {
        transcriptBlocks: ['{"record":0}'],
        attachmentPaths: [file("a.png", "AAAA"), file("b.jpg", "BBBB")],
        systemPromptPath: "/tmp/system-prompt.txt",
    };
    const { prompt } = providerArgs(prepared, "sonnet", "low");
    assert.deepEqual(prompt.map((block) => block.type), ["text", "text", "image", "text", "image"]);
    assert.equal(prompt[3].text, "Image attachment b.jpg:");
    assert.equal(prompt.at(-1).source.media_type, "image/jpeg");
    assert.equal(prompt.at(-1).cache_control, undefined);
});

test("every advertised alias is passed to Claude verbatim", () => {
    const prepared = { transcriptBlocks: [], attachmentPaths: [], systemPromptPath: "/tmp/system.txt" };
    for (const model of ["sonnet", "opus", "haiku", "fable"]) {
        const { args } = providerArgs(prepared, model, "low");
        assert.equal(args[args.indexOf("--model") + 1], model);
    }
});

test("a model without effort control sends no effort flag", () => {
    const prepared = { transcriptBlocks: [], attachmentPaths: [], systemPromptPath: "/tmp/system.txt" };
    const { args: haiku } = providerArgs(prepared, "haiku", undefined, { thinkingDisplay: "summarized" });
    assert.equal(haiku.includes("--effort"), false);
    assert.equal(haiku[haiku.indexOf("--thinking-display") + 1], "summarized");
    const { args } = providerArgs(prepared, "sonnet", "low");
    assert.equal(args[args.indexOf("--effort") + 1], "low");
});

test("pins cache-stable Claude settings", () => {
    const args = baseClaudeArgs();
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
    assert.deepEqual(settings, {
        disableAllHooks: true,
        autoMemoryEnabled: false,
        totalTokensReminder: "off",
        // A safety-classifier flag must end as a refusal, not re-run on another model.
        switchModelsOnFlag: false,
        enabledPlugins: { "agents-md@builtin": false, "telemetry@builtin": false, "plugin-authoring@builtin": false },
    });
});

test("marks exactly the last history block with a 1h cache breakpoint", () => {
    // Claude Code does not mark the transcript, so the transport does.
    // The marker belongs on unchanged history, never on the growing attachment
    // suffix, and must be 1h: the API orders breakpoints longest-TTL-first and
    // Claude Code places a 1h marker after this one. The on-the-wire total is
    // checked by npm run capture:claude-breakpoints, not by a unit test.
    const prepared = {
        directory: "/tmp/private",
        transcriptBlocks: Array.from({ length: 40 }, (_, index) => `{"record":${index}}`),
        attachmentPaths: [file("a.png", "AAAA"), file("b.png", "BBBB")],
        systemPromptPath: "/tmp/private/system-prompt.txt",
        toolNames: new Map(),
        transcriptBytes: 1,
        catalogBytes: 0,
        imageBytes: 1,
    };
    const { prompt } = providerArgs(prepared, "sonnet", "low");
    const marked = prompt.filter((block) => block.cache_control !== undefined);
    assert.deepEqual(marked, [
        { type: "text", text: prepared.transcriptBlocks.at(-1), cache_control: { type: "ephemeral", ttl: "1h" } },
    ]);
    assert.equal(prompt.at(-1).cache_control, undefined);
    // An empty history has nothing to mark; a marker with no block is invalid.
    assert.deepEqual(providerArgs({ ...prepared, transcriptBlocks: [], attachmentPaths: [] }, "sonnet", "low").prompt, []);
});

test("the transcript breakpoint turns off only through a valid setting", () => {
    const prepared = {
        directory: "/tmp/private",
        transcriptBlocks: ['{"record":0}', '{"record":1}'],
        attachmentPaths: [],
        systemPromptPath: "/tmp/private/system-prompt.txt",
        toolNames: new Map(),
        transcriptBytes: 1,
        catalogBytes: 0,
        imageBytes: 0,
    };
    const { prompt } = providerArgs(prepared, "sonnet", "low", { transcriptBreakpoint: false });
    assert.equal(prompt.length, 2);
    assert.equal(prompt.some((block) => "cache_control" in block), false);
    const name = "PI_CLAUDE_CODE_PROVIDER_TRANSCRIPT_BREAKPOINT";
    assert.equal(transcriptBreakpointEnabled({}), true);
    assert.equal(transcriptBreakpointEnabled({ [name]: "on" }), true);
    assert.equal(transcriptBreakpointEnabled({ [name]: " off " }), false);
    assert.throws(() => transcriptBreakpointEnabled({ [name]: "false" }), (error) => error.code === "breakpoint_config");
});

test("proposal MCP server launches the bridge through the hosting runtime", () => {
    const prepared = {
        directory: "/tmp/private",
        transcriptBlocks: ['{"protocol":"test"}'],
        attachmentPaths: [],
        systemPromptPath: "/tmp/private/system-prompt.txt",
        catalogPath: "/tmp/private/catalog.json",
        violationPath: "/tmp/private/violation",
        readyPath: "/tmp/private/ready",
        toolNames: new Map(),
        transcriptBytes: 1,
        catalogBytes: 1,
        imageBytes: 0,
    };
    const { args } = providerArgs(prepared, "sonnet", "medium");
    const server = JSON.parse(args[args.indexOf("--mcp-config") + 1]).mcpServers.pi;
    const expected = scriptLaunch(BRIDGE_PATH);
    assert.equal(server.command, expected.command);
    assert.deepEqual(server.args, expected.args);
    assert.equal(server.env.PI_CLAUDE_TOOL_CATALOG, prepared.catalogPath);
    assert.equal(server.env.PI_CLAUDE_TOOL_VIOLATION, prepared.violationPath);
    assert.equal(server.env.PI_CLAUDE_TOOL_READY, prepared.readyPath);
    // A compiled standalone Pi is its own entry point, so handing it the bridge
    // path without BUN_BE_BUN silently starts a chat instead of the MCP server.
    assert.equal(server.env.BUN_BE_BUN, process.versions.bun ? "1" : undefined);
});

test("script launch adapts to the npm and standalone Pi distributions", () => {
    assert.deepEqual(scriptLaunch("/pkg/bridge.js", [], undefined, "/usr/bin/node", undefined), {
        command: "/usr/bin/node",
        args: ["/pkg/bridge.js"],
        env: {},
    });
    assert.deepEqual(scriptLaunch("/pkg/bridge.js", ["--flag"], undefined, "/opt/pi/pi", "1.3.14"), {
        command: "/opt/pi/pi",
        args: ["/pkg/bridge.js", "--flag"],
        env: { BUN_BE_BUN: "1" },
    });
    // Node ignores a bunfig entirely, so the neutral config is Bun-only.
    assert.deepEqual(scriptLaunch("/pkg/bridge.js", [], "/priv/bunfig.toml", "/usr/bin/node", undefined).args, ["/pkg/bridge.js"]);
});

test("the standalone bridge cannot be preloaded from its working directory", () => {
    // Pi's --no-compile-autoload-bunfig is a property of its own compiled entry
    // point and does not survive BUN_BE_BUN, so the launch must pin the config.
    const launch = scriptLaunch("/pkg/bridge.js", [], "/priv/bunfig.toml", "/opt/pi/pi", "1.3.14");
    assert.deepEqual(launch.args, ["--config=/priv/bunfig.toml", "/pkg/bridge.js"]);
    // Bun ignores a space-separated --config and then swallows the script path,
    // so the joined form is load-bearing rather than stylistic.
    assert.ok(launch.args.every((argument) => argument !== "--config"));
    assert.ok(needsBunConfig("1.3.14"));
    assert.ok(!needsBunConfig(undefined));
    // Every line must be inert: a bunfig this package writes may never itself
    // carry a directive, only comments.
    assert.ok(NEUTRAL_BUN_CONFIG.split("\n").filter(Boolean).every((line) => line.startsWith("#")));
});

test("asks for summarized thinking, which Claude Code otherwise returns empty", () => {
    const prepared = {
        directory: "/tmp/private",
        transcriptBlocks: ['{"record":0}'],
        attachmentPaths: [],
        systemPromptPath: "/tmp/private/system-prompt.txt",
        toolNames: new Map(),
        transcriptBytes: 1,
        catalogBytes: 0,
        imageBytes: 0,
    };
    const displayValue = (options) => {
        const { args } = providerArgs(prepared, "sonnet", "medium", options);
        const index = args.indexOf("--thinking-display");
        // The flag belongs with the other request-shaping options, right after --effort.
        if (index !== -1) assert.equal(args[index - 1], "medium");
        return index === -1 ? undefined : args[index + 1];
    };
    assert.equal(displayValue({ thinkingDisplay: "summarized" }), "summarized");
    assert.equal(displayValue({ thinkingDisplay: "omitted" }), "omitted");
    // Omitted entirely rather than sent empty: an unknown value would be rejected.
    assert.equal(displayValue({}), undefined);

    const name = "PI_CLAUDE_CODE_PROVIDER_THINKING_DISPLAY";
    assert.equal(thinkingDisplay({}), "summarized");
    assert.equal(thinkingDisplay({ [name]: "summarized" }), "summarized");
    assert.equal(thinkingDisplay({ [name]: " omitted " }), "omitted");
    assert.equal(thinkingDisplay({ [name]: "off" }), undefined);
    assert.throws(() => thinkingDisplay({ [name]: "on" }), (error) => error.code === "thinking_display_config");
});
