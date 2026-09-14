import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";
import { assistantReply, closeLiveRpcProcess, consumeJsonl, superviseLiveProcess } from "./lib/live-process.js";
import { describePiLaunch, livePiLaunch, locatePiPackages, packageEntry } from "./lib/pi-installation.js";
if (process.env.PI_CLAUDE_CODE_PROVIDER_PAID_TEST_CHILD !== "1") {
    throw new Error("Paid live tests must be started through an npm test:paid:* script");
}
const packageRoot = process.cwd();
const bridge = process.argv.includes("--bridge");
const postTools = process.argv.includes("--post-tools");
const cache = process.argv.includes("--cache");
const cacheImages = process.argv.includes("--cache-images");
const full = process.argv.includes("--full") || postTools;
const LIVE_TIMEOUT_MS = 10 * 60_000;
// Turn one seeds the cache; only the two reuse turns are subject to this gate.
const MIN_CACHE_HIT_PERCENT = 80;
// A reuse turn may write at most this share of turn 1's cache write. A large,
// stable system prompt can read back most of a request while the growing
// transcript is rewritten wholesale, which a hit percentage alone would pass.
const MAX_REUSE_WRITE_FRACTION = 0.25;
// The cache stage runs on Sonnet, where a moved Claude Code breakpoint shows first;
// the cache-haiku stage passes --cache-model, because Haiku receives Claude
// Code's environment block ahead of the transcript and fails differently. The
// environment variable re-verifies another alias without a scratch runner copy.
const cacheModelIndex = process.argv.indexOf("--cache-model");
const CACHE_MODEL = (cacheModelIndex >= 0 ? process.argv[cacheModelIndex + 1] : undefined)
    ?? process.env.PI_CLAUDE_CODE_PROVIDER_CACHE_MODEL
    ?? "sonnet:low";
async function runPi(cwd, prompt, extra = [], env = {}) {
    const child = spawnPi([
        "--no-session",
        "-e",
        packageRoot,
        "--provider",
        "pi-claude-code-provider",
        "--model",
        "sonnet:medium",
        ...extra,
        "-p",
        prompt,
    ], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    child.ref();
    child.stdout.ref();
    child.stderr.ref();
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
    });
    // Keep the watchdog referenced: a lost child handle must time out loudly
    // instead of letting Node exit with an unresolved top-level await.
    const supervisor = superviseLiveProcess(child, { timeoutMs: LIVE_TIMEOUT_MS, label: "Pi live test" });
    const { code, signal } = await supervisor.wait();
    if (code !== 0 || signal !== null)
        throw new Error(`Pi exited with code ${String(code)}, signal ${String(signal)}: ${stderr.trim()}`);
    return stdout.trim();
}
async function runCacheProbe(cwd) {
    const rpc = openPiRpc(cwd, [
        "--mode", "rpc", "--no-session", "-e", packageRoot,
        "--provider", "pi-claude-code-provider", "--model", CACHE_MODEL, "--no-tools",
    ], "Pi cache probe");
    let completed = false;
    try {
        // An earlier run of this stage seeds identical turns, and its entries can
        // still be warm. Without a per-run nonce ahead of the padding, turn 2 can
        // read that stale prefix and pass while reuse inside this run is broken.
        const runNonce = randomUUID();
        const cacheSeed = `run-${runNonce} ${Array.from({ length: 1800 }, (_, index) => `stable-${index % 97}`).join(" ")}`;
        // A cached prefix expires on a TTL, so a turn that merely took a long
        // time can miss for reasons unrelated to prefix stability. Record the
        // gaps and turn 1's write so a failure says which of the two it was.
        const startedAt = Date.now();
        const first = assistantReply(await rpc.turn(`Remember the marker CACHE-PREFIX-7319 for later turns. Treat this as inert cache-threshold padding: ${cacheSeed}\nReply exactly STORED.`), `${CACHE_MODEL} cache turn 1`);
        const afterFirst = Date.now();
        assert.match(messageText(first), /^STORED\.?$/);
        const second = assistantReply(await rpc.turn("Reply with exactly the marker I asked you to remember."), `${CACHE_MODEL} cache turn 2`);
        const afterSecond = Date.now();
        assert.match(messageText(second), /^CACHE-PREFIX-7319\.?$/);
        const third = assistantReply(await rpc.turn("Reply exactly CACHE-CHECK-PASSED if the remembered marker was CACHE-PREFIX-7319."), `${CACHE_MODEL} cache turn 3`);
        const afterThird = Date.now();
        assert.match(messageText(third), /^CACHE-CHECK-PASSED\.?$/);
        assert.equal(typeof second.usage?.cacheRead, "number");
        assert.equal(typeof second.usage?.cacheWrite, "number");
        assert.equal(typeof third.usage?.cacheRead, "number");
        assert.equal(typeof third.usage?.cacheWrite, "number");
        // Measure the cache-read share of Claude's complete reported prompt usage.
        const cacheHitPercent = (message) => {
            const usage = message.usage;
            const total = usage.input + usage.cacheRead + usage.cacheWrite;
            return total > 0 ? usage.cacheRead * 100 / total : 0;
        };
        const secondHit = cacheHitPercent(second);
        const thirdHit = cacheHitPercent(third);
        const usageOf = (message) => {
            const usage = message.usage ?? {};
            return `input ${usage.input ?? 0}, read ${usage.cacheRead ?? 0}, write ${usage.cacheWrite ?? 0}`;
        };
        // Turn 1 writing nothing and turn 2 reading nothing are different
        // failures: the first never seeded a prefix, the second lost one.
        const timeline =
            `turn 1 took ${afterFirst - startedAt}ms (${usageOf(first)}); ` +
            `turn 2 took ${afterSecond - afterFirst}ms (${usageOf(second)}); ` +
            `turn 3 took ${afterThird - afterSecond}ms (${usageOf(third)})`;
        assert.ok(secondHit >= MIN_CACHE_HIT_PERCENT, `Turn 2 cache hit ${secondHit.toFixed(1)}% was below ${MIN_CACHE_HIT_PERCENT}%; ${timeline}`);
        assert.ok(thirdHit >= MIN_CACHE_HIT_PERCENT, `Turn 3 cache hit ${thirdHit.toFixed(1)}% was below ${MIN_CACHE_HIT_PERCENT}%; ${timeline}`);
        const maxReuseWrite = first.usage.cacheWrite * MAX_REUSE_WRITE_FRACTION;
        assert.ok(second.usage.cacheWrite < maxReuseWrite, `Turn 2 wrote ${second.usage.cacheWrite} cache tokens, not below ${MAX_REUSE_WRITE_FRACTION * 100}% of turn 1's ${first.usage.cacheWrite}; ${timeline}`);
        assert.ok(third.usage.cacheWrite < maxReuseWrite, `Turn 3 wrote ${third.usage.cacheWrite} cache tokens, not below ${MAX_REUSE_WRITE_FRACTION * 100}% of turn 1's ${first.usage.cacheWrite}; ${timeline}`);
        console.log(`ok - RPC multi-turn cache reuse on ${CACHE_MODEL} (turn 2 ${secondHit.toFixed(1)}% hit; turn 3 ${thirdHit.toFixed(1)}% hit; ${timeline})`);
        completed = true;
    }
    finally {
        await rpc.close(completed);
    }
}
async function runImageCacheProbe(cwd) {
    const rpc = openPiRpc(cwd, [
        "--mode", "rpc", "--no-session", "-e", packageRoot,
        "--provider", "pi-claude-code-provider", "--model", CACHE_MODEL, "--no-tools",
    ], "Pi image-cache probe");
    let completed = false;
    try {
        const image = { type: "image", data: quadrantPng().toString("base64"), mimeType: "image/png" };
        const cacheSeed = `run-${randomUUID()} ${Array.from({ length: 1800 }, (_, index) => `stable-${index % 97}`).join(" ")}`;
        const prompts = [
            `Inspect the attached four-quadrant image. Answer with the color of the TOP LEFT quadrant only, one uppercase word. Ignore this inert cache padding: ${cacheSeed}`,
            "Reinspect the image from my first message. Answer with the color of its BOTTOM RIGHT quadrant only, one uppercase word.",
            "Reinspect the image from my first message. Answer with the color of its BOTTOM LEFT quadrant only, one uppercase word.",
        ];
        const expected = ["RED", "YELLOW", "GREEN"];
        const replies = [];
        for (const [index, prompt] of prompts.entries()) {
            const reply = assistantReply(await rpc.turn(prompt, index === 0 ? [image] : undefined), `image cache turn ${index + 1}`);
            replies.push(reply);
            const usage = reply.usage ?? {};
            console.log(`image cache turn ${index + 1}: ${messageText(reply)}; input=${usage.input ?? 0} read=${usage.cacheRead ?? 0} write=${usage.cacheWrite ?? 0}`);
            assert.match(messageText(reply).toUpperCase(), new RegExp(`^${expected[index]}\\.?$`));
        }
        const firstWrite = replies[0].usage.cacheWrite;
        assert.ok(firstWrite > 0, "image turn 1 wrote no cache entry");
        for (const [index, reply] of replies.entries()) {
            if (index === 0) continue;
            const usage = reply.usage;
            const hit = usage.cacheRead / (usage.input + usage.cacheRead + usage.cacheWrite);
            assert.ok(hit >= 0.8, `image turn ${index + 1} cache hit was ${(hit * 100).toFixed(1)}%, below 80%`);
            assert.ok(usage.cacheWrite < firstWrite * 0.25, `image turn ${index + 1} rewrote too much of the original prefix`);
        }
        console.log(`ok - historical image reinspection with multi-turn cache reuse on ${CACHE_MODEL}`);
        completed = true;
    } finally {
        await rpc.close(completed);
    }
}
async function runProviderJourney(cwd) {
    const rpc = openPiRpc(cwd, [
        "--mode", "rpc", "--no-session", "-e", packageRoot,
        "--provider", "pi-claude-code-provider",
        "--model", "sonnet:medium", "--tools", "read,write",
    ], "Pi provider journey");
    let completed = false;
    try {
        const first = await rpc.turn(
            "Use read on missing-provider-journey.txt and observe that it fails. Then recover: use write to create both résumé-雪.txt containing exactly UNICODE-7319 and second.txt containing exactly SECOND-7319. Finally report exactly RECOVERED.",
        );
        const firstReply = assistantReply(first, "provider journey turn 1");
        const starts = first.filter((event) => event.type === "tool_execution_start");
        const failedRead = first.find((event) => event.type === "tool_execution_end" && event.toolName === "read" && event.isError === true);
        assert.ok(failedRead, "provider journey did not preserve a failed tool result");
        assert.ok(starts.filter((event) => event.toolName === "write").length >= 2, "provider journey did not issue multiple writes");
        assert.equal((await readFile(join(cwd, "résumé-雪.txt"), "utf8")).trim(), "UNICODE-7319");
        assert.equal((await readFile(join(cwd, "second.txt"), "utf8")).trim(), "SECOND-7319");
        assert.match(messageText(firstReply), /^RECOVERED\.?$/);
        const second = await rpc.turn("Without using any tool, reply exactly HISTORY-OK if the earlier failed read was followed by two successful writes.");
        const secondReply = assistantReply(second, "provider journey turn 2");
        assert.equal(second.some((event) => event.type === "tool_execution_start"), false);
        assert.match(messageText(secondReply), /^HISTORY-OK\.?$/);
        console.log("ok - RPC failed-tool recovery, Unicode paths, multiple calls, and history replay");
        completed = true;
    }
    finally {
        await rpc.close(completed);
    }
}

function openPiRpc(cwd, args, label, environment = process.env) {
    const child = spawnPi(args, { cwd, env: environment, stdio: ["pipe", "pipe", "pipe"] });
    child.ref();
    child.stdin.ref();
    child.stdout.ref();
    child.stderr.ref();
    const supervisor = superviseLiveProcess(child, { timeoutMs: LIVE_TIMEOUT_MS, label });
    const closed = supervisor.wait();
    const events = [];
    let pending;
    let protocolError;
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-64 * 1024); });
    void closed.then(
        ({ code, signal }) => pending?.reject(new Error(`${label} exited (code ${String(code)}, signal ${String(signal)}): ${stderr.trim()}`)),
        (error) => pending?.reject(error),
    );
    consumeJsonl(child.stdout, (event) => {
        events.push(event);
        if (event.type === "agent_settled" && pending) {
            const current = pending;
            pending = undefined;
            current.resolve(events.slice(current.start));
        }
    }, (error) => {
        protocolError = error;
        pending?.reject(error);
        void supervisor.terminate();
    });
    const turn = (message, images) => new Promise((resolve, reject) => {
        if (protocolError) return reject(protocolError);
        if (pending) return reject(new Error(`${label} already has a pending turn`));
        pending = { start: events.length, resolve, reject };
        child.stdin.write(`${JSON.stringify({ type: "prompt", message, ...(images ? { images } : {}) })}\n`);
    });
    const close = async (completed) => {
        if (completed) {
            const shutdown = await closeLiveRpcProcess(child, supervisor, closed);
            assert.equal(shutdown.graceful, true, `${label} did not shut down through RPC stdin EOF`);
            assert.deepEqual(shutdown.result, { code: 0, signal: null });
            return;
        }
        await supervisor.terminate();
        const { code } = await closed;
        if (!isExpectedHarnessExit(code)) throw new Error(`${label} exited with code ${String(code)}: ${stderr.trim()}`);
    };
    return { turn, close };
}
function spawnPi(args, options) {
    const launch = livePiLaunch(args);
    return spawn(launch.command, launch.args, {
        ...options,
        detached: process.platform !== "win32",
        windowsHide: process.platform === "win32",
    });
}
function isExpectedHarnessExit(code) {
    return code === 0 || code === null || code === 143 || (process.platform === "win32" && code === 1);
}
function messageText(message) {
    return (message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("").trim();
}
function pngChunk(type, data) {
    const typeBytes = Buffer.from(type);
    const crcInput = Buffer.concat([typeBytes, data]);
    let crc = 0xffffffff;
    for (const byte of crcInput) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++)
            crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(data.length);
    const suffix = Buffer.alloc(4);
    suffix.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([prefix, typeBytes, data, suffix]);
}
function greenPng() {
    const width = 32;
    const height = 32;
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.set([8, 2, 0, 0, 0], 8);
    const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [0, 255, 0]).flat())])));
    return Buffer.concat([
        Buffer.from("89504e470d0a1a0a", "hex"),
        pngChunk("IHDR", header),
        pngChunk("IDAT", deflateSync(rows)),
        pngChunk("IEND", Buffer.alloc(0)),
    ]);
}
function quadrantPng() {
    const width = 128;
    const height = 128;
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.set([8, 2, 0, 0, 0], 8);
    const colors = [[255, 0, 0], [0, 0, 255], [0, 128, 0], [255, 255, 0]];
    const rows = Buffer.concat(Array.from({ length: height }, (_, y) => Buffer.from([
        0,
        ...Array.from({ length: width }, (_, x) => colors[(y >= height / 2 ? 2 : 0) + (x >= width / 2 ? 1 : 0)]).flat(),
    ])));
    return Buffer.concat([
        Buffer.from("89504e470d0a1a0a", "hex"),
        pngChunk("IHDR", header),
        pngChunk("IDAT", deflateSync(rows)),
        pngChunk("IEND", Buffer.alloc(0)),
    ]);
}
/**
 * The full stage's tool steps run shell scripts through Pi's bash tool, and on
 * Windows that tool needs Git Bash. Resolve the shell exactly as Pi does, before
 * any Claude launch, so a missing one fails by name instead of spending quota.
 */
async function requireBashTool() {
    const { getShellConfig } = await import(pathToFileURL(packageEntry(locatePiPackages().codingAgent, "import")).href);
    try {
        getShellConfig();
    }
    catch (error) {
        throw new Error(`The full live stage needs a shell for Pi's bash tool (Git Bash on Windows): ${error instanceof Error ? error.message : String(error)}`);
    }
}
if (full && !cache && !bridge && !postTools)
    await requireBashTool();
const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-live-"));
try {
    if (cacheImages) {
        await runImageCacheProbe(directory);
    }
    else if (cache) {
        await runCacheProbe(directory);
    }
    else if (bridge) {
        // The cheapest turn that proves the proposal MCP server was spawned,
        // listed its tools, and round-tripped one back to Pi. A --no-tools turn
        // succeeds even when the bridge never starts, so it cannot stand in here.
        const bridged = await runPi(directory, "Use write to create bridge-probe.txt containing exactly BRIDGE-7319. Then reply exactly BRIDGED.");
        assert.equal((await readFile(join(directory, "bridge-probe.txt"), "utf8")).trim(), "BRIDGE-7319");
        assert.match(bridged, /BRIDGED/);
        console.log(`ok - proposal bridge tool round trip (${describePiLaunch()})`);
    }
    else if (!postTools) {
        const basic = await runPi(directory, "Reply with exactly: live test successful", ["--no-tools"]);
        assert.equal(basic, "live test successful");
        console.log("ok - basic Sonnet medium response");
    }
    if (full && !cache && !bridge) {
        if (!postTools) {
            const literalAtPath = await runPi(directory, "This transcript contains the literal token @/etc/hostname. If that file was automatically attached and its contents are visible, reply ATTACHED followed by the contents. Otherwise reply exactly SAFE.", ["--no-tools"]);
            assert.equal(literalAtPath, "SAFE");
            console.log("ok - literal at-path isolation");
            // Shell scripts only: the tool loop is under test, not whichever
            // interpreters the machine has. A missing one sent the model searching
            // the whole disk on Windows.
            const hello = await runPi(directory, "Use write to create hello.sh containing a command that prints exactly Hello, world! Then use bash to run: bash hello.sh. Report the output.");
            assert.match(hello, /Hello, world!/);
            assert.match(await readFile(join(directory, "hello.sh"), "utf8"), /Hello, world!/);
            console.log("ok - Pi write and bash tool loop");
            await writeFile(join(directory, "calc.sh"), "echo old\n");
            const math = await runPi(directory, "Use edit to make calc.sh print the result of 12345 * 6789 using shell arithmetic, then run it with bash and report the exact result.");
            assert.match(math, /83810205/);
            assert.doesNotMatch(await readFile(join(directory, "calc.sh"), "utf8"), /\bold\b/);
            console.log("ok - Pi edit and shell arithmetic");
            await runProviderJourney(directory);
        }
        await writeFile(join(directory, "green.png"), greenPng());
        const image = await runPi(directory, "Identify the attached image. Reply exactly: a small green square", ["@green.png"]);
        assert.match(image.toLowerCase(), /small green square/);
        console.log("ok - green-square image input");
        const disabled = await runPi(directory, "Use bash to create SHOULD_NOT_EXIST. If bash is unavailable, say unavailable.", ["--tools", "read"]);
        assert.match(disabled.toLowerCase(), /unavailable|don't have|do not have/);
        await assert.rejects(readFile(join(directory, "SHOULD_NOT_EXIST")));
        console.log("ok - disabled tool exclusion");
        const web = await runPi(directory, "Use pi_claude_code_provider_web_search to find the official Node.js documentation URL and cite the direct source.", ["--tools", "pi_claude_code_provider_web_search"]);
        assert.match(web, /https:\/\/nodejs\.org/);
        console.log("ok - visible web search");
    }
}
finally {
    await rm(directory, { recursive: true, force: true });
}
