import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { prepareRequest, prepareRequestWithLimits } from "../../src/context-serializer.ts";
import { needsBunConfig } from "../../src/host-runtime.ts";
import { SessionImageStore } from "../../src/session-image-store.ts";

const transcript = (prepared) => prepared.transcriptBlocks.join("\n");

test("serializes Pi context, tools, literal at-paths, and images privately", async () => {
    const context = {
        systemPrompt: "system is passed separately",
        messages: [
            { role: "user", content: "Do not expand @/etc/passwd", timestamp: 1 },
            {
                role: "assistant",
                content: [
                    { type: "thinking", thinking: "thought", thinkingSignature: "opaque" },
                    { type: "toolCall", id: "call-1", name: "odd tool/name", arguments: { x: 1 } },
                ],
                api: "test",
                provider: "test",
                model: "test",
                usage: {
                    input: 1,
                    output: 1,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 2,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "toolUse",
                timestamp: 2,
            },
            {
                role: "toolResult",
                toolCallId: "call-1",
                toolName: "odd tool/name",
                content: [
                    { type: "text", text: "result" },
                    { type: "image", data: Buffer.from("image bytes").toString("base64"), mimeType: "image/png" },
                ],
                isError: false,
                timestamp: 3,
            },
        ],
        tools: [{ name: "odd tool/name", description: "odd", parameters: Type.Object({ x: Type.Number() }) }],
    };
    const prepared = await prepareRequest(context);
    try {
        if (process.platform !== "win32") assert.equal((await stat(prepared.directory)).mode & 0o777, 0o700);
        assert.equal(prepared.directory, await realpath(prepared.directory));
        assert.equal(await readFile(prepared.systemPromptPath, "utf8"), context.systemPrompt);
        if (process.platform !== "win32") assert.equal((await stat(prepared.systemPromptPath)).mode & 0o777, 0o600);
        assert.equal(transcript(prepared).includes("@"), false);
        assert.equal(prepared.transcriptBlocks.length, 4);
        const [header, ...messages] = prepared.transcriptBlocks.map((line) => JSON.parse(line));
        assert.equal(header.protocol, "pi-claude-code-provider-context-v4");
        assert.equal(messages[0]?.content, "Do not expand @/etc/passwd");
        assert.match(JSON.stringify(messages[2]), /image_attachment/);
        assert.deepEqual(header.toolNameMap.map((entry) => entry.piName), ["odd tool/name"]);
        assert.match(header.toolNameMap[0].transportName, /^mcp__pi__tool_[a-f0-9]{16}$/);
        assert.equal(messages[1].content[1].name, header.toolNameMap[0].transportName);
        assert.equal(messages[2].toolName, header.toolNameMap[0].transportName);
        assert.equal(messages[1].content[0].thinkingSignature, undefined);
        assert.equal(messages[1].usage, undefined);
        assert.equal(prepared.attachmentPaths.length, 1);
        assert.equal(prepared.toolNames.size, 1);
        // The private directory holds exactly what the transport needs and nothing
        // else. Under a standalone Pi that set also includes the neutral bunfig
        // that keeps the bridge from preloading a working-directory config.
        const files = (await readdir(prepared.directory)).sort();
        const expected = [".pi-claude-code-provider-runtime.json", "system-prompt.txt", "tools.json"];
        if (needsBunConfig()) expected.push("bunfig.toml");
        assert.equal(files.length, expected.length + 1);
        assert.deepEqual(files.filter((name) => !/^image-/.test(name)), expected.sort());
        assert.equal(files.filter((name) => /^image-[a-f0-9]{64}\.png$/.test(name)).length, 1);
    }
    finally {
        await rm(prepared.directory, { recursive: true, force: true });
    }
});
test("preserves Unicode edge cases and orphaned tool calls as transcript data", async () => {
    const context = {
        messages: [
            { role: "user", content: "lone surrogate: \ud800", timestamp: 1 },
            {
                role: "assistant",
                content: [{ type: "toolCall", id: "orphan", name: "probe", arguments: { text: "\udfff" } }],
                api: "test",
                provider: "test",
                model: "test",
                usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "toolUse",
                timestamp: 2,
            },
        ],
        tools: [],
    };
    const prepared = await prepareRequest(context);
    try {
        const [, ...messages] = prepared.transcriptBlocks.map((line) => JSON.parse(line));
        assert.equal(messages[0].content, "lone surrogate: \ud800");
        assert.equal(messages[1].content[0].id, "orphan");
        assert.equal(messages[1].content[0].arguments.text, "\udfff");
    }
    finally {
        await rm(prepared.directory, { recursive: true, force: true });
    }
});

test("rejects invalid image input", async () => {
    const context = {
        messages: [
            { role: "user", content: [{ type: "image", data: "%%%", mimeType: "image/png" }], timestamp: 1 },
        ],
    };
    await assert.rejects(prepareRequest(context), /base64/);
});
test("keeps prior transcript bytes stable when a turn is appended", async () => {
    const first = await prepareRequest({ messages: [{ role: "user", content: "first", timestamp: 1 }] });
    const second = await prepareRequest({ messages: [{ role: "user", content: "first", timestamp: 999 }, { role: "user", content: "second", timestamp: 2 }] });
    try {
        assert.equal(transcript(second).startsWith(`${transcript(first)}\n`), true);
        assert.deepEqual(second.transcriptBlocks.slice(0, first.transcriptBlocks.length), first.transcriptBlocks);
    }
    finally {
        await Promise.all([first, second].map((item) => rm(item.directory, { recursive: true, force: true })));
    }
});
test("rejects string-valued assistant content instead of dropping history", async () => {
    await assert.rejects(
        prepareRequest({ messages: [{ role: "assistant", content: "invalid", timestamp: 1 }] }),
        /assistant content must be an array/i,
    );
});
test("enforces the per-role content-block policy", async () => {
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    await assert.rejects(
        prepareRequest({ messages: [{ role: "user", content: [{ type: "thinking", thinking: "leaked" }], timestamp: 1 }] }),
        /thinking content must not appear in user messages/,
    );
    await assert.rejects(
        prepareRequest({
            messages: [{
                role: "assistant",
                content: [{ type: "image", data: Buffer.from("pixels").toString("base64"), mimeType: "image/png" }],
                api: "test",
                provider: "test",
                model: "test",
                usage,
                stopReason: "stop",
                timestamp: 1,
            }],
        }),
        /image content must not appear in assistant messages/,
    );
    await assert.rejects(
        prepareRequest({
            messages: [{ role: "toolResult", toolCallId: "call-1", toolName: "probe", content: [{ type: "toolCall", id: "x", name: "probe", arguments: {} }], isError: false, timestamp: 1 }],
        }),
        /toolCall content must not appear in toolResult messages/,
    );
    await assert.rejects(
        prepareRequest({
            messages: [{ role: "toolResult", toolCallId: "call-1", toolName: "probe", content: "bare string", isError: false, timestamp: 1 }],
        }),
        /toolResult content must be an array/,
    );
    await assert.rejects(
        prepareRequest({ messages: [{ role: "user", content: [{ type: "video", data: "x" }], timestamp: 1 }] }),
        /Unsupported Pi content block: video/,
    );
});
test("sorts tool catalogs and rejects duplicate names", async () => {
    const parameters = Type.Object({ value: Type.String() });
    const prepared = await prepareRequest({ messages: [], tools: [{ name: "zeta", description: "z", parameters }, { name: "alpha", description: "a", parameters }] });
    try {
        const catalog = JSON.parse(await readFile(prepared.catalogPath, "utf8"));
        const aliases = [...prepared.toolNames.values()];
        assert.deepEqual(aliases, ["alpha", "zeta"]);
        assert.deepEqual(catalog.map((tool) => tool.description), ["a", "z"]);
    }
    finally {
        await rm(prepared.directory, { recursive: true, force: true });
    }
    await assert.rejects(prepareRequest({ messages: [], tools: [{ name: "same", description: "a", parameters }, { name: "same", description: "b", parameters }] }), /Duplicate/);
});
test("keeps active, colliding, removed, and paired historical tool identities coherent", async () => {
    const invalidName = "odd tool/name";
    const baseAlias = `tool_${createHash("sha256").update(invalidName).digest("hex").slice(0, 16)}`;
    const collisionName = baseAlias;
    const parameters = Type.Object({ value: Type.String() });
    const assistant = {
        role: "assistant",
        content: [
            { type: "toolCall", id: "active-invalid", name: invalidName, arguments: { value: "one" } },
            { type: "toolCall", id: "active-collision", name: collisionName, arguments: { value: "two" } },
            { type: "toolCall", id: "removed", name: "removed tool", arguments: { value: "three" } },
        ],
        api: "test",
        provider: "test",
        model: "test",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse",
        timestamp: 1,
    };
    const history = [
        assistant,
        { role: "toolResult", toolCallId: "active-invalid", toolName: "mismatched stale name", content: [{ type: "text", text: "one" }], isError: false, timestamp: 2 },
        { role: "toolResult", toolCallId: "active-collision", toolName: collisionName, content: [{ type: "text", text: "two" }], isError: false, timestamp: 3 },
        { role: "toolResult", toolCallId: "removed", toolName: "removed tool", content: [{ type: "text", text: "three" }], isError: false, timestamp: 4 },
        { role: "toolResult", toolCallId: "orphan", toolName: "orphaned tool", content: [{ type: "text", text: "orphan" }], isError: true, timestamp: 5 },
    ];
    const tools = [
        { name: invalidName, description: "invalid", parameters },
        { name: collisionName, description: "collision", parameters },
    ];
    const first = await prepareRequest({ messages: history, tools });
    const second = await prepareRequest({ messages: [...history, { role: "user", content: "continue", timestamp: 6 }], tools });
    try {
        const [header, assistantRecord, ...results] = first.transcriptBlocks.map(JSON.parse);
        assert.deepEqual(header.toolNameMap, [
            { transportName: `mcp__pi__${baseAlias}`, piName: invalidName },
            { transportName: `mcp__pi__${baseAlias}_1`, piName: collisionName },
        ]);
        assert.deepEqual(assistantRecord.content.map((block) => block.id), ["active-invalid", "active-collision", "removed"]);
        assert.deepEqual(assistantRecord.content.slice(0, 2).map((block) => block.name), header.toolNameMap.map((entry) => entry.transportName));
        assert.match(assistantRecord.content[2].name, /^\[unavailable Pi tool [a-f0-9]{16}\]$/);
        assert.equal(results[0].toolName, assistantRecord.content[0].name);
        assert.equal(results[1].toolName, assistantRecord.content[1].name);
        assert.equal(results[2].toolName, assistantRecord.content[2].name);
        assert.match(results[3].toolName, /^\[unavailable Pi tool [a-f0-9]{16}\]$/);
        assert.doesNotMatch(transcript(first), /mismatched stale name|removed tool|orphaned tool/);
        assert.deepEqual(second.transcriptBlocks.slice(0, first.transcriptBlocks.length), first.transcriptBlocks);
    }
    finally {
        await Promise.all([first, second].map((item) => rm(item.directory, { recursive: true, force: true })));
    }
});
test("deduplicates identical images and enforces the image-count limit", async () => {
    const image = { type: "image", data: Buffer.from("same image").toString("base64"), mimeType: "image/png" };
    const prepared = await prepareRequest({ messages: [{ role: "user", content: [image, image], timestamp: 1 }] });
    try {
        assert.equal(prepared.attachmentPaths.length, 1);
        assert.equal(prepared.imageBytes, Buffer.byteLength("same image"));
    }
    finally {
        await rm(prepared.directory, { recursive: true, force: true });
    }
    await assert.rejects(prepareRequest({ messages: [{ role: "user", content: Array.from({ length: 21 }, () => image), timestamp: 1 }] }), /At most 20 images/);
});
test("enforces every configurable serializer resource boundary", async () => {
    const schema = Type.Object({ value: Type.String() });
    await assert.rejects(prepareRequestWithLimits({ messages: [], tools: [{ name: "one", description: "one", parameters: schema }, { name: "two", description: "two", parameters: schema }] }, { tools: 1 }), /At most 1 active tools/);
    await assert.rejects(prepareRequestWithLimits({ messages: [], tools: [{ name: "one", description: "description", parameters: schema }] }, { catalogBytes: 8 }), /catalog exceeds/);
    await assert.rejects(prepareRequestWithLimits({ messages: [{ role: "user", content: "long transcript", timestamp: 1 }] }, { transcriptBytes: 20 }), /context exceeds/);
    const fourBytes = { type: "image", data: Buffer.from("1234").toString("base64"), mimeType: "image/png" };
    await assert.rejects(prepareRequestWithLimits({ messages: [{ role: "user", content: [fourBytes], timestamp: 1 }] }, { imageBytes: 3 }), /between 1 byte and 3 bytes/);
    const otherFourBytes = { type: "image", data: Buffer.from("5678").toString("base64"), mimeType: "image/png" };
    await assert.rejects(prepareRequestWithLimits({ messages: [{ role: "user", content: [fourBytes, otherFourBytes], timestamp: 1 }] }, { totalImageBytes: 7 }), /Aggregate image size/);
    await assert.rejects(prepareRequestWithLimits({ messages: [{ role: "user", content: [fourBytes, fourBytes], timestamp: 1 }] }, { images: 1 }), /At most 1 images/);
});

test("canonicalizes aliased temp roots containing spaces and decomposed Unicode", { skip: process.platform === "win32" }, async () => {
    const fixture = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-path-alias-"));
    const physicalRoot = join(fixture, "unicode-e\u0301");
    const aliasRoot = join(fixture, "alias with spaces");
    await mkdir(physicalRoot);
    await symlink(physicalRoot, aliasRoot);
    try {
        const prepared = await prepareRequestWithLimits({ systemPrompt: "private", messages: [] }, {}, aliasRoot);
        try {
            assert.equal(prepared.directory, await realpath(prepared.directory));
            assert.equal(prepared.directory.startsWith(`${await realpath(physicalRoot)}/`), true);
            assert.equal(await readFile(prepared.systemPromptPath, "utf8"), "private");
        }
        finally {
            await rm(prepared.directory, { recursive: true, force: true });
        }
    }
    finally {
        await rm(fixture, { recursive: true, force: true });
    }
});

test("aliases tool names Claude Code would rename, so its initialization matches the catalog", async () => {
    const parameters = Type.Object({ value: Type.String() });
    const prepared = await prepareRequest({
        messages: [],
        tools: [{ name: "foo.bar", description: "dotted", parameters }, { name: "foo_bar", description: "underscored", parameters }],
    });
    try {
        const transportNames = [...prepared.toolNames.keys()];
        assert.equal(new Set(transportNames).size, 2);
        for (const name of transportNames) {
            assert.match(name, /^mcp__pi__[A-Za-z0-9_-]+$/);
            // Claude Code replaces every other character with "_" when it names an MCP tool.
            assert.equal(name.replace(/[^A-Za-z0-9_-]/g, "_"), name);
        }
        assert.equal(prepared.toolNames.get("mcp__pi__foo_bar"), "foo_bar");
    }
    finally {
        await rm(prepared.directory, { recursive: true, force: true });
    }
});

const pixels = (text) => ({ type: "image", data: Buffer.from(text).toString("base64"), mimeType: "image/png" });
const imageName = (text) => `image-${createHash("sha256").update(text).digest("hex")}.png`;
function assistantMessage(content, stopReason = "stop") {
    return {
        role: "assistant",
        content,
        api: "test",
        provider: "test",
        model: "test",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason,
        timestamp: 2,
    };
}

test("retains an earlier turn's image and append-stable transcript record", async () => {
    const imageTurn = { role: "user", content: [{ type: "text", text: "first screenshot" }, pixels("old image")], timestamp: 1 };
    const current = await prepareRequest({ messages: [imageTurn] });
    const later = await prepareRequest({
        messages: [imageTurn, assistantMessage([{ type: "text", text: "seen" }]), { role: "user", content: "no image now", timestamp: 3 }],
    });
    try {
        assert.deepEqual(current.attachmentPaths.map((path) => basename(path)), [imageName("old image")]);
        assert.deepEqual(later.attachmentPaths.map((path) => basename(path)), [imageName("old image")]);
        assert.equal(later.imageBytes, Buffer.byteLength("old image"));
        // The record is unchanged, so the history prefix the earlier request cached still matches.
        assert.deepEqual(later.transcriptBlocks.slice(0, current.transcriptBlocks.length), current.transcriptBlocks);
    }
    finally {
        await Promise.all([current, later].map((item) => rm(item.directory, { recursive: true, force: true })));
    }
});

test("session image store reattaches an answered image at the same private path", async () => {
    const store = new SessionImageStore();
    store.open();
    const firstLease = store.acquire();
    const laterLease = store.acquire();
    let first;
    let later;
    try {
        const imageTurn = { role: "user", content: [{ type: "text", text: "look left" }, pixels("historic image")], timestamp: 1 };
        first = await prepareRequest({ messages: [imageTurn] }, firstLease);
        later = await prepareRequest({
            messages: [imageTurn, assistantMessage([{ type: "text", text: "left side seen" }]), { role: "user", content: "look right", timestamp: 3 }],
        }, laterLease);
        const stablePath = join(first.imageStoreDirectory, imageName("historic image"));
        assert.notEqual(first.directory, later.directory);
        assert.deepEqual(first.attachmentPaths, [stablePath]);
        assert.deepEqual(later.attachmentPaths, [stablePath]);
        assert.equal((await readFile(stablePath)).toString(), "historic image");
        assert.deepEqual(later.transcriptBlocks.slice(0, first.transcriptBlocks.length), first.transcriptBlocks);
    } finally {
        firstLease.release();
        laterLease.release();
        await Promise.all([first?.directory, later?.directory].filter(Boolean).map((directory) => rm(directory, { recursive: true, force: true })));
        await store.close();
    }
});

test("attaches historical, current, and tool-result images", async () => {
    const prepared = await prepareRequest({
        messages: [
            { role: "user", content: [pixels("old")], timestamp: 1 },
            assistantMessage([{ type: "text", text: "seen" }]),
            { role: "user", content: [{ type: "text", text: "look at this" }, pixels("current")], timestamp: 3 },
            assistantMessage([{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "shot.png" } }], "toolUse"),
            { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [pixels("tool result")], isError: false, timestamp: 5 },
        ],
    });
    try {
        assert.deepEqual(prepared.attachmentPaths.map((path) => basename(path)), [imageName("old"), imageName("current"), imageName("tool result")]);
    }
    finally {
        await rm(prepared.directory, { recursive: true, force: true });
    }
});

test("attaches an image sent in consecutive user messages before any reply", async () => {
    const prepared = await prepareRequest({
        messages: [
            { role: "user", content: [pixels("unanswered")], timestamp: 1 },
            { role: "user", content: "Focus on the error in that screenshot", timestamp: 2 },
        ],
    });
    try {
        assert.deepEqual(prepared.attachmentPaths.map((path) => basename(path)), [imageName("unanswered")]);
    }
    finally {
        await rm(prepared.directory, { recursive: true, force: true });
    }
});

test("attaches a tool-result image when steering arrives before the next reply", async () => {
    const prepared = await prepareRequest({
        messages: [
            { role: "user", content: [{ type: "text", text: "check the page" }, pixels("answered")], timestamp: 1 },
            assistantMessage([{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "shot.png" } }], "toolUse"),
            { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [pixels("tool result")], isError: false, timestamp: 3 },
            { role: "user", content: "Compare it with the old layout instead", timestamp: 4 },
        ],
    });
    try {
        assert.deepEqual(prepared.attachmentPaths.map((path) => basename(path)), [imageName("answered"), imageName("tool result")]);
    }
    finally {
        await rm(prepared.directory, { recursive: true, force: true });
    }
});

test("keeps attaching an image whose request failed before any reply", async () => {
    const prepared = await prepareRequest({
        messages: [
            { role: "user", content: [pixels("unanswered")], timestamp: 1 },
            assistantMessage([], "error"),
            { role: "user", content: "try again", timestamp: 3 },
        ],
    });
    try {
        assert.deepEqual(prepared.attachmentPaths.map((path) => basename(path)), [imageName("unanswered")]);
    }
    finally {
        await rm(prepared.directory, { recursive: true, force: true });
    }
});

test("rejects a non-boolean redacted flag and a non-string image MIME type", async () => {
    await assert.rejects(
        prepareRequest({ messages: [assistantMessage([{ type: "thinking", thinking: "reasoning", redacted: "true" }])] }),
        (error) => error.code === "content_shape" && /thinking redacted must be boolean/.test(error.message),
    );
    await assert.rejects(
        prepareRequest({ messages: [{ role: "user", content: [{ type: "image", data: "AA==", mimeType: ["image/png"] }], timestamp: 1 }] }),
        (error) => error.code === "content_shape" && /string mimeType/.test(error.message),
    );
});

test("counts historical images toward the 20-image limit", async () => {
    await assert.rejects(prepareRequest({
        messages: [
            { role: "user", content: Array.from({ length: 21 }, (_, index) => pixels(`old ${index}`)), timestamp: 1 },
            assistantMessage([{ type: "text", text: "seen" }]),
            { role: "user", content: [pixels("current")], timestamp: 3 },
        ],
    }), (error) => error.code === "image_count" && /At most 20 images/.test(error.message));
});

test("attaches images by absolute path under a temp root with spaces, and refuses a root containing a double quote", { skip: process.platform === "win32" }, async () => {
    const fixture = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-attachment-root-"));
    const spaced = join(fixture, "root with spaces");
    const quoted = join(fixture, 'root "quoted"');
    await mkdir(spaced);
    await mkdir(quoted);
    const image = { type: "image", data: Buffer.from("png!").toString("base64"), mimeType: "image/png" };
    const context = { messages: [{ role: "user", content: [image], timestamp: 1 }] };
    try {
        const prepared = await prepareRequestWithLimits(context, {}, spaced);
        try {
            assert.equal(prepared.attachmentPaths.length, 1);
            assert.equal(prepared.attachmentPaths[0].startsWith(`${prepared.directory}/`), true);
            assert.equal(prepared.directory.includes("root with spaces"), true);
            // Claude runs in Pi's session directory, not this one, so the header
            // must not describe Claude's cwd as provider-private.
            const header = JSON.parse(prepared.transcriptBlocks[0]);
            assert.match(header.instruction, /Generated attachments are provider-private; never pass their paths to Pi tools\./);
            assert.doesNotMatch(header.instruction, /transport cwd/);
        }
        finally {
            await rm(prepared.directory, { recursive: true, force: true });
        }
        // Claude Code's quoted @-reference cannot contain a double quote.
        await assert.rejects(
            prepareRequestWithLimits(context, {}, quoted),
            (error) => error.code === "image_path" && /double quote/.test(error.message),
        );
        assert.deepEqual(await readdir(quoted), []);
    }
    finally {
        await rm(fixture, { recursive: true, force: true });
    }
});
