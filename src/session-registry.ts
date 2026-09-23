import type { RateLimitNoticeSink } from "./claude-protocol.ts";
import type { SessionImageStore } from "./session-image-store.ts";

/** The per-session state a request needs, owned by the instance that started that session. */
export interface SessionEntry {
  cwd: string;
  imageStore: SessionImageStore;
  onRateLimitNotice: RateLimitNoticeSink;
}

/** Where the working directory came from, recorded in metrics. */
export type SessionResolution = "registered" | "prompt" | "single" | "oneshot";

export interface ResolvedSession extends SessionEntry {
  resolution: SessionResolution;
}

export interface SessionRequest {
  sessionId?: string;
  systemPrompt?: string;
  hasTools: boolean;
  allowBorrowSoleDirectory?: boolean;
}

// Process-global rather than module-scoped, because a Pi host can hold more than
// one live session and this module can be evaluated more than once. Pi replaces
// the session and re-runs every extension factory on a new, resumed, forked or
// cloned session, and clears its extension cache on reload or a change of working
// directory, which re-evaluates this module. An SDK host that shares one resource
// loader across sessions shares the extension instances with them. A map held in
// module scope would therefore let one evaluation's sessions be invisible to
// another's, and state held in a factory's closure would serve whichever session
// registered last, because Pi's model runtime keeps only the newest provider.
const REGISTRY_KEY = Symbol.for("pi-claude-code-provider.sessions.v1");

export function sessionRegistry(): Map<string, SessionEntry> {
  const host = globalThis as Record<symbol, unknown>;
  const existing = host[REGISTRY_KEY];
  if (existing instanceof Map) return existing as Map<string, SessionEntry>;
  const registry = new Map<string, SessionEntry>();
  host[REGISTRY_KEY] = registry;
  return registry;
}

/**
 * The working directory stated for this request, or undefined when the prompt
 * names none. Best effort by construction, and two declaration forms are
 * recognized: a `<cwd>` section, which is what Pi itself renders, and a trailing
 * `Current working directory:` line, which a direct or upstream caller may author
 * for a session this package never registered. Both arrive here the same way,
 * recovered from the transcript's system messages, because Pi folds a caller's
 * prompt into them verbatim. An extension that forces the system prompt can omit
 * cwd entirely.
 *
 * Both readings take the *last* statement, and that is load-bearing rather than
 * incidental. Pi renders project context -- the repository's own instruction
 * files, which this provider does not author -- ahead of the directory, so
 * matching the last section and anchoring the trailing line to the end of the
 * prompt is what keeps a repository from naming the directory Claude
 * runs in. Preferring an earlier match would hand that choice to project files:
 * directly for a request whose session is unknown, where this is the only source
 * of truth, and as a refusal for one whose session is known, where a disagreeing
 * prompt fails the request.
 *
 * Ordering alone is a defense this package cannot verify, though: it holds only
 * while Pi keeps rendering project context first, and a change there would be
 * silent. A section nested inside a project-context element is therefore
 * discarded outright, whatever its position, and the last-match rule stays as the
 * second line of defense rather than the only one.
 */
const PROJECT_CONTEXT_SPAN = /<(project_context|project_instructions)\b[^>]*>[\s\S]*?<\/\1>/g;

export function promptWorkingDirectory(systemPrompt: string | undefined): string | undefined {
  if (!systemPrompt) return undefined;
  const repositoryAuthored = [...systemPrompt.matchAll(PROJECT_CONTEXT_SPAN)]
    .map((span) => [span.index, span.index + span[0].length] as const);
  const sections = [...systemPrompt.matchAll(/<cwd>\r?\n([^\n]+)\r?\n<\/cwd>/g)]
    .filter((section) => !repositoryAuthored.some(([start, end]) => section.index >= start && section.index < end));
  const section = sections.at(-1);
  const trailingLine = /\r?\nCurrent working directory: ([^\n]+)\s*$/.exec(systemPrompt);
  const stated = trailingLine && (!section || trailingLine.index > section.index) ? trailingLine[1] : section?.[1];
  return stated?.trim() || undefined;
}

/**
 * Resolve the directory before a payload hook can change the request. Prompt
 * declarations are a cooperative convention, not authenticated session data.
 * `undefined` means no session is live at all.
 */
export function resolveSession(
  registry: ReadonlyMap<string, SessionEntry>,
  request: SessionRequest,
): ResolvedSession | { error: string } | undefined {
  const stated = promptWorkingDirectory(request.systemPrompt);
  const registered = request.sessionId === undefined ? undefined : registry.get(request.sessionId);
  if (registered) {
    if (stated !== undefined && !sameDirectory(stated, registered.cwd)) {
      return {
        error: `Pi's system prompt names ${stated} as the working directory but this request's session runs in ${registered.cwd}; refusing to run Claude in another session's directory`,
      };
    }
    return { ...registered, resolution: "registered" };
  }
  const live = [...registry.values()];
  if (live.length === 0) return undefined;
  if (stated !== undefined) {
    // A session this instance never started, reached through a provider another
    // session registered: an extension driving its own agent loop under a session
    // id of its own, or a host holding several sessions. Pi states where the
    // request belongs, so run there rather than in the registered session's tree,
    // which that caller's own tools never touch. The rest of the session state is
    // borrowed, preferring a live session already in that directory; both are
    // private temporary state.
    const host = live.findLast((entry) => sameDirectory(entry.cwd, stated)) ?? live[live.length - 1];
    return { ...host, cwd: stated, resolution: "prompt" };
  }
  // Pi's compaction and branch summaries arrive with a freshly generated session
  // id and no tools. Their prompt carries no directory, so the newest live
  // session hosts them rather than failing /compact. This does not prove that
  // the summary belongs to that session.
  if (!request.hasTools) return { ...live[live.length - 1], resolution: "oneshot" };
  // A direct Agent can have a different cwd even when this provider registered
  // only one session. Preserve the old borrow solely as an explicit opt-in.
  if (live.length === 1 && request.allowBorrowSoleDirectory) {
    return { ...live[0], resolution: "single" };
  }
  return {
    error: live.length === 1
      ? `this tool-bearing request (${request.sessionId ?? "no session id"}) has no registered session or recognized working directory in its original Pi system prompt; refusing to borrow the sole live session's directory. The caller must state its cwd in Pi's prompt format, or set PI_CLAUDE_CODE_PROVIDER_BORROW_SOLE_DIRECTORY=on to accept the ambiguous borrow`
      : `this tool-bearing request (${request.sessionId ?? "no session id"}) has no registered session or recognized working directory in its original Pi system prompt and ${live.length} sessions are live`,
  };
}

function sameDirectory(left: string, right: string): boolean {
  const normalize = (path: string) => {
    const separated = path.replace(/\\/g, "/").replace(/\/+$/, "");
    // Pi renders the directory with forward slashes on every platform, so the
    // comparison is separator-insensitive; Windows paths are also case-folded.
    return process.platform === "win32" ? separated.toLowerCase() : separated;
  };
  return normalize(left) === normalize(right);
}
