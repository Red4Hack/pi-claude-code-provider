import { chmod, lstat, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { isProcessAlive, isValidPid } from "./process-utils.ts";

const MARKER_NAME = ".pi-claude-code-provider-runtime.json";
const MARKER_SCHEMA = "pi-claude-code-provider-runtime-v1";
const MINIMUM_STALE_AGE_MS = 60 * 60_000;
const MAX_CLEANUP_CANDIDATES = 256;
// Reaping runs while Pi is starting, so bound both how many abandoned groups one
// pass will chase and how long it waits for each to die.
const MAX_REAPED_PROCESSES = 8;
const REAP_GRACE_MS = 250;

export type RuntimeDirectoryKind = "provider_request" | "web_search_request" | "web_search_output";

const PREFIXES: Record<RuntimeDirectoryKind, string> = {
  provider_request: "pi-claude-code-provider-request-",
  web_search_request: "pi-claude-code-provider-search-",
  web_search_output: "pi-claude-code-provider-search-output-",
};

interface RuntimeMarker {
  schema: typeof MARKER_SCHEMA;
  kind: RuntimeDirectoryKind;
  ownerPid: number;
  childPid?: number;
  createdAt: string;
}

interface CreateRuntimeDirectoryOptions {
  temporaryRoot?: string;
  ownerPid?: number;
  now?: number;
}

interface CleanupRuntimeDirectoryOptions {
  temporaryRoot?: string;
  currentUid?: number;
  now?: number;
  minimumAgeMs?: number;
  maxCandidates?: number;
  maxReaped?: number;
  processAlive?: (pid: number) => boolean;
  /** Internal seam: the working directory a live process reports, or undefined. */
  processDirectory?: (pid: number) => Promise<string | undefined>;
  /** Internal seam: terminate an abandoned process group, reporting whether it died. */
  terminateGroup?: (pid: number) => Promise<boolean>;
}

export interface RuntimeCleanupResult {
  removed: number;
  failures: number;
  /** Abandoned Claude process groups terminated because their Pi process is gone. */
  reaped: number;
}

export async function removeRuntimeDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

export async function createRuntimeDirectory(
  kind: RuntimeDirectoryKind,
  options: CreateRuntimeDirectoryOptions = {},
): Promise<string> {
  const temporaryDirectory = await mkdtemp(join(options.temporaryRoot ?? tmpdir(), PREFIXES[kind]));
  try {
    const directory = await realpath(temporaryDirectory);
    await chmod(directory, 0o700);
    const marker: RuntimeMarker = {
      schema: MARKER_SCHEMA,
      kind,
      ownerPid: options.ownerPid ?? process.pid,
      createdAt: new Date(options.now ?? Date.now()).toISOString(),
    };
    await writeFile(markerPath(directory), `${JSON.stringify(marker)}\n`, { mode: 0o600, flag: "wx" });
    return directory;
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function recordRuntimeChild(directory: string, childPid: number): Promise<void> {
  if (!isValidPid(childPid)) throw new Error("Claude Code child process has no valid process ID");
  const marker = await readMarker(directory);
  if (!marker) throw new Error("Private runtime directory marker is missing or invalid");
  await writeFile(markerPath(directory), `${JSON.stringify({ ...marker, childPid })}\n`, { mode: 0o600 });
  await chmod(markerPath(directory), 0o600);
}

/** Best-effort recovery for state left by an abruptly terminated Pi process. */
export async function cleanupStaleRuntimeDirectories(
  options: CleanupRuntimeDirectoryOptions = {},
): Promise<RuntimeCleanupResult> {
  const currentUid = options.currentUid ?? process.getuid?.();
  if (currentUid === undefined) return { removed: 0, failures: 0, reaped: 0 };
  const temporaryRoot = options.temporaryRoot ?? tmpdir();
  const now = options.now ?? Date.now();
  const minimumAgeMs = options.minimumAgeMs ?? MINIMUM_STALE_AGE_MS;
  const maxCandidates = options.maxCandidates ?? MAX_CLEANUP_CANDIDATES;
  const processAlive = options.processAlive ?? isProcessAlive;
  const processDirectory = options.processDirectory ?? processWorkingDirectory;
  const terminateGroup = options.terminateGroup ?? terminateAbandonedGroup;
  const maxReaped = options.maxReaped ?? MAX_REAPED_PROCESSES;
  let entries;
  try {
    entries = await readdir(temporaryRoot, { withFileTypes: true });
  } catch {
    return { removed: 0, failures: 1, reaped: 0 };
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory() && runtimeKind(entry.name) !== undefined)
    .slice(0, Math.max(0, maxCandidates));
  let removed = 0;
  let failures = 0;
  let reaped = 0;
  for (const entry of candidates) {
    const directory = join(temporaryRoot, entry.name);
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.uid !== currentUid) continue;
      const marker = await readMarker(directory);
      const kind = runtimeKind(entry.name);
      if (!marker || marker.kind !== kind) continue;
      const createdAt = Date.parse(marker.createdAt);
      if (!Number.isFinite(createdAt) || now - createdAt < minimumAgeMs) continue;
      if (processAlive(marker.ownerPid)) continue;
      if (marker.childPid !== undefined && processAlive(marker.childPid)) {
        // The Pi process that owned this request is gone while its Claude
        // process group is still running: an abruptly killed host leaves that
        // group holding memory and a subscription slot with nothing to report
        // to. Terminate it only once the live process still proves it is this
        // request's child, so a reused process identifier can never be signalled.
        if (reaped >= maxReaped) continue;
        if ((await processDirectory(marker.childPid)) !== directory) continue;
        if (!(await terminateGroup(marker.childPid))) {
          failures += 1;
          continue;
        }
        reaped += 1;
      }
      const current = await lstat(directory);
      if (!current.isDirectory() || current.uid !== currentUid) continue;
      await rm(directory, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Report only an aggregate count: cleanup diagnostics must not expose paths.
      failures += 1;
    }
  }
  return { removed, failures, reaped };
}

/**
 * Prove that a live process is the child this marker recorded. Every Claude
 * process this package starts runs with its private request directory as its
 * working directory, and that directory name carries `mkdtemp` randomness, so
 * matching it rules out an unrelated process that inherited a reused
 * identifier. Linux only: `/proc` is the one reading that needs no subprocess,
 * and elsewhere an unproven process is left alone exactly as before.
 */
async function processWorkingDirectory(pid: number): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    return await readlink(`/proc/${pid}/cwd`);
  } catch {
    return undefined;
  }
}

async function terminateAbandonedGroup(pid: number): Promise<boolean> {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      // The group, not the process: Claude Code owns the proposal bridge, and
      // every process here is spawned detached as its own group leader.
      process.kill(-pid, signal);
    } catch (error) {
      return isMissingProcessError(error);
    }
    const deadline = Date.now() + REAP_GRACE_MS;
    while (Date.now() < deadline) {
      if (!isProcessAlive(pid)) return true;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
  return !isProcessAlive(pid);
}

function isMissingProcessError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
}

function runtimeKind(name: string): RuntimeDirectoryKind | undefined {
  // Prefixes nest: a web_search_output name also starts with the
  // web_search_request prefix. Longest match keeps each kind distinguishable,
  // because a misread kind is discarded by the marker comparison in cleanup.
  return (Object.entries(PREFIXES) as Array<[RuntimeDirectoryKind, string]>)
    .filter(([, prefix]) => name.startsWith(prefix))
    .sort(([, left], [, right]) => right.length - left.length)[0]?.[0];
}

async function readMarker(directory: string): Promise<RuntimeMarker | undefined> {
  try {
    const path = markerPath(directory);
    const info = await lstat(path);
    if (!info.isFile() || info.size > 1024) return undefined;
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<RuntimeMarker>;
    if (
      value.schema !== MARKER_SCHEMA ||
      !isRuntimeKind(value.kind) ||
      !isValidPid(value.ownerPid) ||
      (value.childPid !== undefined && !isValidPid(value.childPid)) ||
      typeof value.createdAt !== "string" ||
      !basename(directory).startsWith(PREFIXES[value.kind])
    ) return undefined;
    return value as RuntimeMarker;
  } catch {
    return undefined;
  }
}

function markerPath(directory: string): string {
  return join(directory, MARKER_NAME);
}

function isRuntimeKind(value: unknown): value is RuntimeDirectoryKind {
  return typeof value === "string" && value in PREFIXES;
}

