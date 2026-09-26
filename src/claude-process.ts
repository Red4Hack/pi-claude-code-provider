import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { buildClaudeEnvironment, claudeLaunch } from "./auth.ts";
import { stderrExcerpt } from "./claude-protocol.ts";
import { appendCleanupFailure, ClaudeCodeError, errorCode, errorText } from "./errors.ts";
import { ProcessTerminationError, type ProcessSupervisor, type superviseProcess } from "./process-utils.ts";
import { recordRuntimeChild } from "./runtime-directories.ts";
import { tailText } from "./text.ts";
import type { ClaudeInstallation } from "./types.ts";

// Enough stderr to explain a failure; error messages carry only a bounded excerpt.
const MAX_STDERR_CHARS = 64 * 1024;

export interface ClaudeProcessOptions {
  installation: ClaudeInstallation;
  args: readonly string[];
  /** Variables added to the allowlisted Claude environment. */
  env?: NodeJS.ProcessEnv;
  /**
   * The private runtime directory: owner of the marker, stale-state recovery and
   * stderr redaction, and the child's cwd unless `cwd` is given.
   */
  directory: string;
  /** Additional provider-private paths included in diagnostics redaction. */
  privatePaths?: readonly string[];
  /**
   * The child's cwd. Provider requests pass Pi's session directory, because
   * Claude Code reports its cwd to the model as the primary working directory.
   * Web search has no Pi tools to misdirect and keeps the private directory.
   */
  cwd?: string;
  stdin: "pipe" | "ignore";
  idleTimeoutMs: number;
  totalTimeoutMs: number;
  signal?: AbortSignal;
  supervise: typeof superviseProcess;
  onFailure: (error: Error) => void;
  /** Caller bookkeeping for a cancellation after spawn; termination follows it. */
  onAbort?: () => void;
  onBackgroundTerminationFailure?: (error: unknown) => void;
}

/** A spawned Claude process and the lifecycle operations its caller needs. */
export interface ClaudeProcess {
  readonly child: ChildProcess;
  readonly supervisor: ProcessSupervisor;
  /** Record the child PID in the private directory marker for stale-state recovery. */
  recordOwnership(): Promise<void>;
  /** Bounded stderr tail with the private directory redacted. */
  stderrExcerpt(): string;
  /** Memoized termination of the owned process tree; remembers the first failure. */
  terminate(): Promise<void>;
  /** Terminate without awaiting; the failure stays observable through wait() and terminate(). */
  terminateInBackground(): void;
  isTerminationFailure(error: unknown): boolean;
  /** Remove the cancellation listener and release supervision. */
  dispose(): void;
}

/**
 * Claim a paid-test launch slot for a request that is still wanted. The claim
 * can suspend while no cancellation listener exists yet, so cancellation is
 * checked on both sides: an already-cancelled request never starts Claude.
 */
export async function claimClaudeLaunch(signal: AbortSignal | undefined, claimLaunch: () => Promise<void>): Promise<void> {
  throwIfAborted(signal);
  await claimLaunch();
  throwIfAborted(signal);
}

/**
 * Start Claude in `cwd`, or else its private runtime directory, and take
 * ownership of it: a POSIX process-group leader or hidden Windows child,
 * supervised, with a bounded stderr tail and a cancellation listener registered
 * before the caller awaits.
 */
export function spawnClaudeProcess(options: ClaudeProcessOptions): ClaudeProcess {
  const launch = claudeLaunch(options.installation.executable, options.args);
  const child = spawn(launch.command, launch.args, {
    cwd: options.cwd ?? options.directory,
    env: buildClaudeEnvironment({ ...launch.env, ...options.env }),
    detached: process.platform !== "win32",
    windowsHide: process.platform === "win32",
    stdio: [options.stdin, "pipe", "pipe"],
  });
  const supervisor = options.supervise(child, {
    idleTimeoutMs: options.idleTimeoutMs,
    totalTimeoutMs: options.totalTimeoutMs,
    onFailure: (error) => options.onFailure(vanishedExecutable(error, options.installation.executable) ?? error),
  });
  let terminationFailure: unknown;
  const terminate = async (): Promise<void> => {
    try {
      await supervisor.terminate();
    } catch (error) {
      terminationFailure ??= error;
      throw error;
    }
  };
  const terminateInBackground = (): void => {
    // The memoized termination is awaited again before the request settles, so
    // its failure is reported there rather than masking an earlier failure here.
    void terminate().catch((error: unknown) => options.onBackgroundTerminationFailure?.(error));
  };
  const abortHandler = (): void => {
    options.onAbort?.();
    terminateInBackground();
  };
  options.signal?.addEventListener("abort", abortHandler, { once: true });
  if (options.signal?.aborted) abortHandler();

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = tailText(stderr, chunk, MAX_STDERR_CHARS);
  });

  return {
    child,
    supervisor,
    // A child that failed to spawn has no PID and nothing to own; its spawn error
    // reaches onFailure, which already names the cause.
    recordOwnership: async () => {
      if (child.pid !== undefined) await recordRuntimeChild(options.directory, child.pid);
    },
    stderrExcerpt: () => stderrExcerpt(stderr, [options.directory, ...(options.privatePaths ?? [])]),
    terminate,
    terminateInBackground,
    isTerminationFailure: (error) => terminationFailure !== undefined && error === terminationFailure,
    dispose(): void {
      options.signal?.removeEventListener("abort", abortHandler);
      supervisor.dispose();
    },
  };
}

/**
 * Finish process handling for a failed request and compose its message. A
 * ProcessTerminationError means death could not be established, so private
 * state must be retained. Any other failure still terminates the process tree,
 * and a termination failure the message does not already state is appended.
 */
export async function settleFailure(
  claude: ClaudeProcess | undefined,
  error: unknown,
  message: string,
  retainedNote: string,
): Promise<{ message: string; livenessUnknown: boolean }> {
  if (error instanceof ProcessTerminationError) return { message: `${message}; ${retainedNote}`, livenessUnknown: true };
  if (!claude) return { message, livenessUnknown: false };
  try {
    await claude.terminate();
    return { message, livenessUnknown: false };
  } catch (terminationError) {
    const alreadyStated = terminationError === error && message === errorText(error);
    return {
      message: alreadyStated ? message : appendCleanupFailure(message, "Claude Code process tree", terminationError),
      livenessUnknown: terminationError instanceof ProcessTerminationError,
    };
  }
}

/**
 * Preflight resolves Claude Code to the real path of the build it validated, and
 * a native install's updater later deletes old builds. A session that outlives
 * that would otherwise fail every request with a bare spawn ENOENT.
 */
function vanishedExecutable(error: Error, executable: string): ClaudeCodeError | undefined {
  if (errorCode(error) !== "ENOENT" || existsSync(executable)) return undefined;
  return new ClaudeCodeError(
    "executable_missing",
    `Claude Code at ${executable} no longer exists, probably removed by a Claude Code update; run /reload`,
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ClaudeCodeError("aborted", "Claude Code request was aborted");
}
