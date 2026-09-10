import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ClaudeEventMapper } from "../../src/stream-events.ts";
import { createOutput } from "../../src/output.ts";

/**
 * Replay a protocol artifact Claude Code really emitted for a request built by
 * `providerArgs`. Every other protocol test states what this package believes
 * the CLI emits; this one states what it emitted. Produce it with
 * `npm run capture:claude-protocol`, which needs no subscription quota because
 * Claude Code can be pointed at a custom model endpoint.
 *
 * The artifact is local and untracked: it carries one machine's run, and a
 * capture is only as current as the CLI that produced it. These cases therefore
 * skip when it is absent rather than fail, so a clone without one still runs a
 * green suite — and report loudly the moment a capture exists and disagrees.
 *
 * The capture necessarily authenticates with an API key — a subscription
 * capture would spend quota — so the artifact carries `apiKeySource:
 * "ANTHROPIC_API_KEY"`. That is not a defect of the artifact: the first case
 * below uses it to prove the isolation gate against a real record, and the
 * second normalizes only that one field to exercise the body mapping.
 */

const MISSING = "no captured Claude Code protocol; run npm run capture:claude-protocol";
// Whatever version is on this machine: the artifact is untracked, so pinning one
// would skip for every contributor whose CLI has moved on.
const directory = fileURLToPath(new URL("../support/captured/", import.meta.url));
const captured = readdirSync(directory).filter((name) => name.endsWith("-protocol.jsonl")).sort().at(-1);
const capturedVersion = captured?.match(/^claude-(.+)-protocol\.jsonl$/)?.[1];
const records = captured
  ? readFileSync(`${directory}${captured}`, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
  : undefined;

const model = {
  id: "sonnet",
  name: "Sonnet",
  api: "pi-claude-code-provider-headless",
  provider: "pi-claude-code-provider",
  baseUrl: "pi-claude-code-provider://local",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 64_000,
};

function mapperFor() {
  const stream = createAssistantMessageEventStream();
  const output = createOutput(model);
  const mapper = new ClaudeEventMapper({
    stream,
    output,
    expectedTools: new Set(["mcp__pi__read"]),
    toolNames: new Map([["mcp__pi__read", "read"]]),
    onToolUse: () => {},
  });
  return { stream, output, mapper };
}

test("the captured initialization is refused because it is not subscription-backed", (t) => {
  if (!records) return t.skip(MISSING);
  const { mapper } = mapperFor();
  // A real Claude Code record, rejected by the real validator: the provider
  // accepts only subscription authentication, whatever else the record contains.
  assert.equal(records[0].apiKeySource, "ANTHROPIC_API_KEY");
  assert.throws(() => mapper.accept(records[0]), /subscription-backed/);
});

test("a captured Claude Code turn maps to a completed assistant message", async (t) => {
  if (!records) return t.skip(MISSING);
  const { stream, output, mapper } = mapperFor();
  const consumed = [];
  const consume = (async () => {
    for await (const event of stream) consumed.push(event.type);
  })();
  for (const record of records) {
    mapper.accept(record.type === "system" && record.subtype === "init" ? { ...record, apiKeySource: "none" } : record);
  }
  assert.equal(mapper.hasSuccessfulResult, true);
  mapper.completeResult();
  const result = await stream.result();
  await consume;

  assert.equal(result.stopReason, "stop");
  assert.equal(result.content.find((block) => block.type === "text")?.text, "CAPTURED-OK");
  // Claude Code interleaves records this package must tolerate rather than map:
  // per-turn status and running thinking-token counters.
  assert.ok(records.some((record) => record.subtype === "thinking_tokens"), "the artifact should carry the interleaved counters");
  assert.ok(records.some((record) => record.type === "assistant"), "the artifact should carry the completed message echo");
  // Usage reaches Pi from Claude's own counters rather than from an estimate.
  // Assert that it arrived, not one run's numbers, which differ per capture.
  const reported = records.at(-1).usage;
  assert.equal(result.usage.input, reported.input_tokens);
  assert.equal(result.usage.cacheRead, reported.cache_read_input_tokens);
  assert.equal(result.usage.output, reported.output_tokens);
  assert.ok(result.usage.input > 0, "the capture should carry real prompt counters");
  assert.deepEqual(consumed.slice(0, 2), ["start", "thinking_start"]);
  assert.equal(consumed.at(-1), "done");
});

test("the captured artifact still describes the request this package makes", (t) => {
  if (!records) return t.skip(MISSING);
  const init = records[0];
  // A capture taken with other arguments would describe a request that never
  // happens here: the tool catalog, the isolation flags, and the proposal
  // server all have to be the ones `providerArgs` asks for.
  assert.deepEqual(init.tools, ["mcp__pi__read"]);
  assert.deepEqual(init.mcp_servers, [{ name: "pi", status: "connected" }]);
  assert.equal(init.permissionMode, "dontAsk");
  assert.deepEqual([init.slash_commands, init.skills, init.plugins], [[], [], []]);
  // The artifact must say which CLI produced it, and its name must not lie about that.
  assert.equal(init.claude_code_version, capturedVersion);
});
