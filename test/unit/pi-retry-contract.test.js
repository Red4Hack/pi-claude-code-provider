import assert from "node:assert/strict";
import test from "node:test";
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";
import { normalizeClaudeFailure } from "../../src/errors.ts";

/**
 * Pi decides whether to restart a failed turn by matching substrings in the
 * failure text, so what this provider writes there is a real interface. These
 * cases run Pi's own classifier rather than a local restatement of it: a Pi
 * release that changes the rules should fail here instead of silently
 * reintroducing a retry loop that spends a Claude launch per attempt.
 *
 * Every failure text below was taken from a real session transcript.
 */

const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const failure = (errorMessage) => ({ role: "assistant", stopReason: "error", errorMessage, usage: EMPTY_USAGE });

test("an exhausted subscription window stops the turn instead of restarting it", () => {
  const limit = "Claude Code request failed (429): You've hit your session limit · resets 3:50am (America/Sao_Paulo)";
  // Pi reads the 429 as transient throttling, so the untreated text restarts a
  // turn that cannot succeed until the window resets.
  assert.equal(isRetryableAssistantError(failure(limit)), true);
  assert.equal(isRetryableAssistantError(failure(normalizeClaudeFailure(limit))), false);
  // The window is exhausted, not oversized: compaction must not be triggered either.
  assert.equal(isContextOverflow(failure(normalizeClaudeFailure(limit)), 200_000), false);
});

test("a readiness deadline is reported in seconds so a duration cannot read as an HTTP status", () => {
  // "5000ms" contains "500", which Pi matches as a retryable server error, so
  // the old wording restarted a request that needed a fix rather than a retry.
  assert.equal(isRetryableAssistantError(failure("Pi proposal MCP server did not become ready within 5000ms")), true);
  assert.equal(isRetryableAssistantError(failure("Pi proposal MCP server did not become ready within 20s")), false);
});

test("a transient failure stays retryable", () => {
  for (const transient of [
    "Claude Code request failed (529): overloaded",
    "Claude Code request failed: fetch failed",
    "Claude Code exited before a terminal event: socket hang up",
  ]) {
    assert.equal(isRetryableAssistantError(failure(transient)), true, transient);
    assert.equal(isRetryableAssistantError(failure(normalizeClaudeFailure(transient))), true, transient);
  }
});

test("a context budget refusal reaches Pi as overflow, which compacts rather than retries", () => {
  const budget = failure(
    "context_length_exceeded: estimated Claude Code transport input 190447 leaves no room for a reply within context 200000",
  );
  assert.equal(isContextOverflow(budget, 200_000), true);
  // Pi checks overflow first and skips retry for it; assert the pairing that
  // decision depends on, so a message that satisfied neither could not slip by.
  assert.equal(isContextOverflow(budget, 200_000) || !isRetryableAssistantError(budget), true);
});

test("Claude's own overflow wording is recognized after normalization", () => {
  const overflow = "Claude Code request failed (400): prompt is too long: 213462 tokens > 200000 maximum";
  assert.equal(isContextOverflow(failure(normalizeClaudeFailure(overflow)), 200_000), true);
});
