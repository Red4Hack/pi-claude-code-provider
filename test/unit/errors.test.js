import assert from "node:assert/strict";
import test from "node:test";
import { normalizeClaudeFailure, normalizeClaudeOverflow, normalizeClaudeUsageLimit } from "../../src/errors.ts";

test("normalizes Claude overflow wording idempotently", () => {
  assert.equal(
    normalizeClaudeOverflow("Prompt is too long for this model"),
    "context_length_exceeded: Prompt is too long for this model",
  );
  assert.equal(
    normalizeClaudeOverflow("context_length_exceeded: Prompt is too long"),
    "context_length_exceeded: Prompt is too long",
  );
});

test("does not normalize rate limits or unrelated large requests", () => {
  assert.equal(normalizeClaudeOverflow("rate limit: too many requests"), "rate limit: too many requests");
  assert.equal(normalizeClaudeOverflow("rate limit: too many tokens per minute"), "rate limit: too many tokens per minute");
  assert.equal(normalizeClaudeOverflow("request too large"), "request too large");
});

test("marks an exhausted subscription window so Pi stops instead of retrying it", () => {
  // Claude Code reports these as HTTP 429, which Pi otherwise reads as transient
  // throttling and retries until its budget is gone, once per Claude launch.
  for (const failure of [
    "Claude Code request failed (429): You've hit your session limit · resets 3:50am (America/Sao_Paulo)",
    "Claude Code request failed (429): Claude AI usage limit reached",
    "Claude rate limit rejected (seven_day); resets at 2026-09-11T06:50:00.000Z",
    "Claude Code exited before a terminal event; weekly limit reached · resets Monday",
  ]) {
    const normalized = normalizeClaudeUsageLimit(failure);
    assert.equal(normalized, `quota exceeded: ${failure}`);
    // Idempotent: the same message must not accumulate markers across hooks.
    assert.equal(normalizeClaudeUsageLimit(normalized), normalized);
  }
});

test("leaves a genuinely transient failure retryable", () => {
  for (const failure of [
    "Claude Code request failed (429): too many requests, please retry",
    "Claude Code request failed (529): overloaded",
    "Claude Code produced no protocol activity for 300000ms",
    "Pi proposal MCP server did not become ready within 20s",
  ]) {
    assert.equal(normalizeClaudeUsageLimit(failure), failure);
  }
});

test("one normalization boundary applies both overflow and usage-limit wording", () => {
  assert.equal(
    normalizeClaudeFailure("Prompt is too long for this model"),
    "context_length_exceeded: Prompt is too long for this model",
  );
  assert.equal(
    normalizeClaudeFailure("Claude Code request failed (429): You've hit your session limit"),
    "quota exceeded: Claude Code request failed (429): You've hit your session limit",
  );
  assert.equal(normalizeClaudeFailure("Claude Code exited with code 1"), "Claude Code exited with code 1");
});
