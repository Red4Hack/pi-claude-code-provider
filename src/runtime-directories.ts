import { chmod, lstat, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { isProcessAlive, validPid } from "./process-utils.ts";

const MARKER_NAME = ".pi-claude-code-provider-runtime.json";
const MARKER_SCHEMA = "pi-claude-code-provider-runtime-v1";
const MINIMUM_STALE_AGE_MS = 60 * 60_000;
const MAX_DELETION_ATTEMPTS = 256;
// Reaping runs while Pi is starting, so bound both how many abandoned groups one
// pass will chase and how long it waits for each to die.
const MAX_REAPED_PROCESSES = 8;
const REAP_GRACE_MS = 250;

export type RuntimeDirectoryKind = "provider_request" | "provider_image_store" | "web_search_request" | "web_search_output" | "bridge_probe";

const PREFIXES: Record<RuntimeDirectoryKind, string> = {
  provider_request: "pi-claude-code-provider-request-",
  provider_image_store: "pi-claude-code-provider-images-",
  web_search_request: "pi-claude-code-provider-search-",
  web_search_output: "pi-claude-code-provider-search-output-",
  bridge_probe: "pi-claude-code-provider-bridge-probe-",
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
  maxDeletionAttempts?: number;
  maxReaped?: number;
  /** Existence probe: negative IDs identify POSIX process groups. */
  processAlive?: (pid: number) => boolean;
  /** Internal seam: whether a live process proves it belongs to a runtime directory. */
  processOwnsDirectory?: (pid: number, directory: string) => Promise<boolean>;
  /** Internal seam: terminate an abandoned process group, reporting whether it died. */
  terminateGroup?: (pid: number) => Promise<boolean>;
  /** Internal seams for deterministic filesystem-failure tests. */
  inspectDirectory?: typeof lstat;
  removeDirectory?: typeof removeRuntimeDirectory;
}

export interface RuntimeCleanupResult {
  removed: number;
  failures: number;
  /** Abandoned Claude process groups terminated because their Pi process is gone. */
  reaped: number;
}

export async function removeRuntimeDirectory(directory: string): Promise<void> {
  // A just-exited child can briefly hold files here; retry transient removal errors.
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
  if (!validPid(childPid)) throw new Error("Claude Code child process has no valid process ID");
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
  const maxDeletionAttempts = options.maxDeletionAttempts ?? MAX_DELETION_ATTEMPTS;
  if (maxDeletionAttempts <= 0) return { removed: 0, failures: 0, reaped: 0 };
  const processAlive = options.processAlive ?? isProcessAlive;
  const processOwnsDirectory = options.processOwnsDirectory ?? processReferencesDirectory;
  const terminateGroup = options.terminateGroup ?? terminateAbandonedGroup;
  const maxReaped = options.maxReaped ?? MAX_REAPED_PROCESSES;
  const inspectDirectory = options.inspectDirectory ?? lstat;
  const removeDirectory = options.removeDirectory ?? removeRuntimeDirectory;
  const childAlive = (marker: RuntimeMarker): boolean => marker.childPid !== undefined &&
    (processAlive(marker.childPid) || processAlive(-marker.childPid));
  let entries;
  try {
    entries = await readdir(temporaryRoot, { withFileTypes: true });
  } catch {
    return { removed: 0, failures: 1, reaped: 0 };
  }
  const eligible = entries.filter((entry) => entry.isDirectory() && runtimeKind(entry.name) !== undefined)
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  // Inspect all ownership before deleting: a request beyond the deletion budget
  // can protect images earlier in the ordering. Budget deletions, not inspection,
  // so an accumulation of stale images can drain across successive passes.
  const candidates: Array<{ directory: string; marker: RuntimeMarker }> = [];
  const ownersWithLiveProviderChildren = new Set<number>();
  let ownershipIncomplete = false;
  let removed = 0;
  let failures = 0;
  let reaped = 0;
  for (const entry of eligible) {
    const directory = join(temporaryRoot, entry.name);
    try {
      const info = await inspectDirectory(directory);
      if (!info.isDirectory() || info.uid !== currentUid) continue;
      const marker = await readMarker(directory);
      const kind = runtimeKind(entry.name);
      if (!marker || marker.kind !== kind) continue;
      candidates.push({ directory, marker });
      if (kind === "provider_request" && childAlive(marker)) ownersWithLiveProviderChildren.add(marker.ownerPid);
    } catch {
      if (runtimeKind(entry.name) === "provider_request") ownershipIncomplete = true;
      failures += 1;
    }
  }
  let attempts = 0;
  for (const { directory, marker } of candidates) {
    if (attempts >= maxDeletionAttempts) break;
    try {
      if (marker.kind === "provider_image_store" && (ownershipIncomplete || ownersWithLiveProviderChildren.has(marker.ownerPid))) continue;
      const createdAt = Date.parse(marker.createdAt);
      if (!Number.isFinite(createdAt) || now - createdAt < minimumAgeMs) continue;
      if (processAlive(marker.ownerPid)) continue;
      if (marker.childPid !== undefined && childAlive(marker)) {
        // The Pi process that owned this request is gone while its Claude
        // process group is still running: an abruptly killed host leaves that
        // group holding memory and a subscription slot with nothing to report
        // to. Terminate it only once the live process still proves it is this
        // request's child, so a reused process identifier can never be signalled.
        // A group whose leader already exited cannot offer that proof and is
        // left alone, together with its directory, exactly as before.
        if (reaped >= maxReaped) continue;
        if (!(await processOwnsDirectory(marker.childPid, directory))) continue;
        if (!(await terminateGroup(marker.childPid))) {
          failures += 1;
          continue;
        }
        reaped += 1;
      }
      const current = await inspectDirectory(directory);
      if (!current.isDirectory() || current.uid !== currentUid) continue;
      attempts += 1;
      await removeDirectory(directory);
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
 * process this package starts names its private runtime directory where
 * `/proc` can see it: web search runs with that directory as its working
 * directory, and a provider request, which runs in Pi's session directory,
 * passes its system-prompt file from it on the command line. The directory name
 * carries `mkdtemp` randomness, so either reading rules out an unrelated process
 * that inherited a reused identifier. Linux only: `/proc` is the one reading
 * that needs no subprocess, and elsewhere an unproven process is left alone
 * exactly as before.
 */
async function processReferencesDirectory(pid: number, directory: string): Promise<boolean> {
  if (process.platform !== "linux") return false;
  const candidates = new Set([directory]);
  try {
    candidates.add(await realpath(directory));
  } catch {
    // The unresolved path still counts; removal re-checks the directory itself.
  }
  try {
    if (candidates.has(await readlink(`/proc/${pid}/cwd`))) return true;
  } catch {
    // An unreadable working directory leaves the command line as the proof.
  }
  try {
    const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
    return argv.some((argument) => [...candidates].some((candidate) => argument.startsWith(`${candidate}/`)));
  } catch {
    return false;
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
      !value || typeof value !== "object" || Array.isArray(value) ||
      value.schema !== MARKER_SCHEMA ||
      !isRuntimeKind(value.kind) ||
      !validPid(value.ownerPid) ||
      (value.childPid !== undefined && !validPid(value.childPid)) ||
      typeof value.createdAt !== "string" ||
      !basename(directory).startsWith(PREFIXES[value.kind])
    ) return undefined;
    return value as RuntimeMarker;
  } catch (error) {
    // Missing/invalid markers grant no deletion authority. Other filesystem
    // errors must reach the ownership scan so it cannot silently delete images.
    if (error instanceof SyntaxError || (error && typeof error === "object" && "code" in error && error.code === "ENOENT")) return undefined;
    throw error;
  }
}

function markerPath(directory: string): string {
  return join(directory, MARKER_NAME);
}

function isRuntimeKind(value: unknown): value is RuntimeDirectoryKind {
  return typeof value === "string" && value in PREFIXES;
}
