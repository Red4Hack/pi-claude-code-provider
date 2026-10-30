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
 * Pi 1.4.0 requests no `maxTokens` for summaries, so the provider's ceiling is the
 * model's maximum and reasoning has room to finish before the answer; a summary
 * cut off at the ceiling is discarded whole and paid for again. These cases drive the real `generateSummaryWithUsage`
 * through this provider so that contract is checked end to end.
 *
 * The numbers are from a real session: `compaction.reserveTokens` of 8192, which
 * asks for 6553 answer tokens, and summaries that cost 8695 and 8897 output tokens.
 */

const RESERVE_TOKENS = 8_192;
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
    const streamFn = createClaudeStream({ executable, version: "2.1.270", subscriptionType: "pro" }, { resolveSession: () => ({ cwd: tmpdir() }) });
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

test("a compaction summary is given the model's full output ceiling", async () => {
  const summary = "The parser work renamed the token reader and split the lexer; documentation is pending.";
  await withProviderStream(completionPayload({ content: summary, reasoning: "weighing what to keep" }), async ({ streamFn, server }) => {
    const result = await summarize(streamFn, "max");
    assert.equal(result.text, summary);
    // With no maxTokens requested, the ceiling is the model maximum, so reasoning
    // cannot starve the summary of room to finish.
    assert.equal(server.requests[0].body.max_tokens, model.maxTokens);
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

test("the thinking level does not change the ceiling when Pi requests none", async () => {
  const summary = "Short summary.";
  for (const level of ["max", "medium", "low"]) {
    await withProviderStream(completionPayload({ content: summary }), async ({ streamFn, server }) => {
      const result = await summarize(streamFn, level);
      assert.equal(result.text, summary);
      assert.equal(server.requests[0].body.max_tokens, model.maxTokens, `level ${level}`);
    });
  }
});
