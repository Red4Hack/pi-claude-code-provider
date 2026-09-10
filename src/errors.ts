export class ClaudeCodeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ClaudeCodeError";
    this.code = code;
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function appendCleanupFailure(primary: string | undefined, subject: string, cleanupError: unknown): string {
  const cleanup = `${subject} cleanup failed: ${errorText(cleanupError)}`;
  return primary ? `${primary}; ${cleanup}` : cleanup;
}

const CLAUDE_OVERFLOW = /(?:prompt is too long|prompt too long|context window exceeded|context length exceeded)/i;

/** Normalize only Claude-specific overflow wording; leave rate limits and unrelated failures untouched. */
export function normalizeClaudeOverflow(errorMessage: string): string {
  if (errorMessage.includes("context_length_exceeded") || !CLAUDE_OVERFLOW.test(errorMessage)) return errorMessage;
  return `context_length_exceeded: ${errorMessage}`;
}

// Claude Code reports an exhausted subscription window as an HTTP 429 result or
// a rejected rate-limit event. Pi's retry classifier reads "429" and "rate
// limit" as transient throttling and restarts the turn, which cannot succeed
// before the window resets and spends a Claude launch on every attempt. Pi
// stops immediately on an account-limit marker instead, so name the condition
// it recognizes. Deliberately narrow: a genuinely transient throttle carries
// none of this wording and stays retryable.
const CLAUDE_USAGE_LIMIT =
  /usage limit reached|session limit|weekly limit|five[- ]hour limit|rate limit rejected|hit your [\w -]*limit|limit reached[^\n]*resets/i;

/** Pi's non-retryable account-limit marker; see `isRetryableAssistantError` in pi-ai. */
export const USAGE_LIMIT_MARKER = "quota exceeded";

/** Mark an exhausted Claude subscription window so Pi stops instead of retrying it. */
export function normalizeClaudeUsageLimit(errorMessage: string): string {
  if (errorMessage.toLowerCase().includes(USAGE_LIMIT_MARKER) || !CLAUDE_USAGE_LIMIT.test(errorMessage)) {
    return errorMessage;
  }
  return `${USAGE_LIMIT_MARKER}: ${errorMessage}`;
}

/** Single normalization boundary between a provider failure and Pi's error classifiers. */
export function normalizeClaudeFailure(errorMessage: string): string {
  return normalizeClaudeUsageLimit(normalizeClaudeOverflow(errorMessage));
}
