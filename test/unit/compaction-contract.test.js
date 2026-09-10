import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateSummaryWithUsage } from "@earendil-works/pi-coding-agent";
import { createClaudeStream } from "../../src/provider.ts";
import { createLocalClaudeExecutable } from "../support/local-claude.js";
import { completionPayload, startLocalModelServer } from "../support/local-model-server.js";

/**
 * Compaction runs through Pi's own summarization path, not a restatement of it.
 * Pi treats its requested `maxTokens` as the budget for the answer and expects
 * reasoning to get room on top; a summary cut off at the ceiling is discarded
 * whole and paid for again. These cases drive the real `generateSummaryWithUsage`
 * through this provider so that contract is checked end to end.
 *
 * The numbers are from a real session: `compaction.reserveTokens` of 8192, which
 * asks for 6553 answer tokens, and summaries that cost 8695 and 8897 output tokens.
 */

const RESERVE_TOKENS = 8_192;
const ANSWER_BUDGET = Math.floor(0.8 * RESERVE_TOKENS);
const MAX_THINKING_BUDGET = 16_384;
const model = {
  id: "opus",
  name: "Opus",
  api: "pi-claude-code-provider-headless",
  provider: "pi-claude-code-provider",
  baseUrl: "pi-claude-code-provider://local",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 64_000,
};
const conversation = [
  { role: "user", content: "Refactor the parser and keep the tests green.", timestamp: 1 },
  { role: "assistant", content: [{ type: "text", text: "Renamed the token reader and split the lexer." }], timestamp: 2 },
  { role: "user", content: "Now document it.", timestamp: 3 },
];

async function withProviderStream(reply, run) {
  const directory = await mkdtemp(join(tmpdir(), "compaction-contract-"));
  const server = await startLocalModelServer(reply);
  try {
    const executable = await createLocalClaudeExecutable(directory, { baseUrl: server.baseUrl, model: "local-test-model" });
    const streamFn = createClaudeStream({ executable, version: "2.1.261", subscriptionType: "pro" });
    await run({ streamFn, server });
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}

/** Pi's summarization call is positional; name the arguments it actually reads. */
function summarize(streamFn, thinkingLevel) {
  return generateSummaryWithUsage(
    conversation, model, RESERVE_TOKENS,
    undefined, undefined, undefined, undefined, undefined,
    thinkingLevel, streamFn,
  );
}

test("a compaction summary is given reasoning room on top of Pi's answer budget", async () => {
  const summary = "The parser work renamed the token reader and split the lexer; documentation is pending.";
  await withProviderStream(completionPayload({ content: summary, reasoning: "weighing what to keep" }), async ({ streamFn, server }) => {
    const result = await summarize(streamFn, "max");
    assert.equal(result.text, summary);
    // Treating the request as the whole ceiling left reasoning eating the
    // summary's room, which is what truncated it into a discarded compaction.
    assert.equal(server.requests[0].body.max_tokens, ANSWER_BUDGET + MAX_THINKING_BUDGET);
    assert.ok(server.requests[0].body.max_tokens > 8_897, "the ceiling must clear the summaries this session actually produced");
  });
});

test("Pi discards a summary that stopped at its ceiling, which is why the ceiling matters", async () => {
  await withProviderStream(completionPayload({ content: "half a summ", finishReason: "length" }), async ({ streamFn }) => {
    // Pi's own rule: a length stop is not a checkpoint. The whole compaction is
    // thrown away and the next trigger pays for another one.
    await assert.rejects(summarize(streamFn, "max"), /token cap|incomplete/i);
  });
});

test("the reasoning room follows the level Pi asked for", async () => {
  const summary = "Short summary.";
  for (const [level, budget] of [["max", 16_384], ["medium", 8_192], ["low", 2_048]]) {
    await withProviderStream(completionPayload({ content: summary }), async ({ streamFn, server }) => {
      const result = await summarize(streamFn, level);
      assert.equal(result.text, summary);
      assert.equal(server.requests[0].body.max_tokens, ANSWER_BUDGET + budget, `level ${level}`);
    });
  }
});
