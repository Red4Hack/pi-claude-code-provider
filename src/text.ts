/**
 * Bounded diagnostic capture. Claude Code's stderr and the bridge probe's
 * output are unbounded streams that this package keeps only to explain a
 * failure, so every accumulator caps what it retains. Both helpers avoid
 * reallocating the retained text while it is still under its bound, which is
 * the common case for a healthy request.
 */

/** Append `chunk`, keeping at most the last `maxCharacters` of the result. */
export function tailText(current: string, chunk: Buffer | string, maxCharacters: number): string {
  const next = appended(current, chunk);
  return next.length > maxCharacters ? next.slice(next.length - maxCharacters) : next;
}

/** Append `chunk`, keeping at most the first `maxCharacters` of the result. */
export function headText(current: string, chunk: Buffer | string, maxCharacters: number): string {
  if (current.length >= maxCharacters) return current;
  const next = appended(current, chunk);
  return next.length > maxCharacters ? next.slice(0, maxCharacters) : next;
}

function appended(current: string, chunk: Buffer | string): string {
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  return current.length === 0 ? text : `${current}${text}`;
}
