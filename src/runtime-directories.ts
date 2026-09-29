import type { ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { chmod, lstat, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { forceTerminateProcessTreeSync, isProcessAlive, validPid, type ForceTerminateSyncDependencies } from "./process-utils.ts";

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
  // Only a completed removal ends ownership; a failed one stays for the exit reaper.
  runtimeState().entries.delete(directory);
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
    if (marker.ownerPid === process.pid) registerOwnedDirectory(directory, kind);
    return directory;
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function recordRuntimeChild(directory: string, childPid: number, child?: ChildProcess): Promise<void> {
  if (!validPid(childPid)) throw new Error("Claude Code child process has no valid process ID");
  // Recorded before the marker write, which can fail: the child exists either way.
  const owned = runtimeState().entries.get(directory);
  if (owned) {
    owned.pid = childPid;
    owned.child = child;
  }
  const marker = await readMarker(directory);
  if (!marker) throw new Error("Private runtime directory marker is missing or invalid");
  await writeFile(markerPath(directory), `${JSON.stringify({ ...marker, childPid })}\n`, { mode: 0o600 });
  await chmod(markerPath(directory), 0o600);
}

interface OwnedRuntimeDirectory {
  kind: RuntimeDirectoryKind;
  pid?: number;
  child?: ChildProcess;
  /** The owned process tree is known to be gone. */
  confirmed: boolean;
  /** Process liveness is unknown, so the directory is left for stale recovery. */
  retained: boolean;
}

interface RuntimeState {
  version: 1;
  entries: Map<string, OwnedRuntimeDirectory>;
  listening: boolean;
}

// Process-global for the same reason as the session registry: pi-subagents
// runners and Pi's extension-cache resets evaluate this module more than once in
// one process, and every evaluation's directories must reach the single exit
// listener, which must itself be installed only once.
const RUNTIME_STATE_KEY = Symbol.for("pi-claude-code-provider.runtime-state.v1");

function runtimeState(): RuntimeState {
  const host = globalThis as Record<symbol, unknown>;
  const existing = host[RUNTIME_STATE_KEY] as Partial<RuntimeState> | undefined;
  if (existing?.version === 1 && existing.entries instanceof Map) return existing as RuntimeState;
  const created: RuntimeState = { version: 1, entries: new Map(), listening: false };
  host[RUNTIME_STATE_KEY] = created;
  return created;
}

/**
 * Hosts exit as soon as a session is disposed: Pi awaits `session_shutdown`,
 * then its dispose aborts the turn, then it calls `process.exit`, and a
 * pi-subagents runner exits the same way once its run stops. The abort sends
 * SIGTERM synchronously, but removal and lease release follow an `await` that
 * never resumes, so without this the private state would wait for a later stale
 * pass -- and on Windows, which has none, it would stay.
 */
function registerOwnedDirectory(directory: string, kind: RuntimeDirectoryKind): void {
  const state = runtimeState();
  state.entries.set(directory, { kind, confirmed: false, retained: false });
  if (state.listening) return;
  state.listening = true;
  process.once("exit", () => reapRuntimeStateAtExit());
}

/** The directory's owned process tree terminated; the exit reaper need not signal it. */
export function confirmRuntimeChildExit(directory: string): void {
  const owned = runtimeState().entries.get(directory);
  if (owned) owned.confirmed = true;
}

/** Process liveness is unknown: keep this directory even at exit, as the asynchronous path does. */
export function retainRuntimeDirectory(directory: string): void {
  const owned = runtimeState().entries.get(directory);
  if (owned) owned.retained = true;
}

export interface ReapRuntimeStateDependencies extends ForceTerminateSyncDependencies {
  remove?: (directory: string) => void;
}

/**
 * Synchronously finish what asynchronous cleanup did not reach before the
 * process exits. A tree not yet confirmed gone is forced down first; one whose
 * death still cannot be established keeps its directory, and while any such
 * child may live, image stores stay too, which is stale recovery's rule. Never
 * throws: it runs inside the host's `exit` listeners.
 */
export function reapRuntimeStateAtExit(dependencies: ReapRuntimeStateDependencies = {}): void {
  try {
    const { entries } = runtimeState();
    const remove = dependencies.remove ?? removeRuntimeDirectorySync;
    const reclaim = (directory: string): void => {
      try {
        remove(directory);
        entries.delete(directory);
      } catch {
        // Left for stale recovery; nothing later in this process can retry.
      }
    };
    let childMayLive = false;
    for (const [directory, owned] of [...entries]) {
      if (owned.pid === undefined) continue;
      if (owned.retained || (!owned.confirmed && !forceTerminateProcessTreeSync(owned.pid, owned.child, dependencies))) {
        childMayLive = true;
        continue;
      }
      reclaim(directory);
    }
    for (const [directory, owned] of [...entries]) {
      if (owned.pid !== undefined || owned.retained) continue;
      if (owned.kind === "provider_image_store" && childMayLive) continue;
      reclaim(directory);
    }
  } catch {
    // An exit listener must not turn a clean exit into a crash.
  }
}

function removeRuntimeDirectorySync(directory: string): void {
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/**
 * Every spelling of the given private directories under the temporary root.
 * The directories are created at their resolved path, but the temporary root
 * is often reached through an alias -- macOS's `/var/folders` is a link into
 * `/private/var`, and Windows `TEMP` can hold an 8.3 short name -- so a path
 * check or redaction that knows only one spelling misses the other. Other
 * links are still not followed.
 */
export function privatePathSpellings(directories: readonly string[], lexicalRoot: string, physicalRoot: string): string[] {
  const trim = (root: string): string => root.replace(/[\\/]+$/, "");
  const roots = [trim(physicalRoot), trim(lexicalRoot)];
  const spellings = new Set<string>();
  for (const directory of directories) {
    spellings.add(directory);
    for (const [from, to] of [[roots[0]!, roots[1]!], [roots[1]!, roots[0]!]] as const) {
      if (from === to || !from) continue;
      const rest = directory.slice(from.length);
      if (directory.startsWith(from) && (rest === "" || rest.startsWith("/") || rest.startsWith("\\"))) spellings.add(`${to}${rest}`);
    }
  }
  return [...spellings];
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
        // The group probe, not the leader's exit, proves the termination: a member
        // that outlived the leader, the proposal bridge say, still holds this
        // directory, so it stays until no member of the group is left.
        if (!(await terminateGroup(marker.childPid)) || childAlive(marker)) {
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
  // Wait for the group, not its leader: the leader can die on SIGTERM while a
  // member that ignores it lives on, and only escalating until the group probe
  // reports absence leaves nothing running behind a removed directory.
  const groupAlive = (): boolean => isProcessAlive(pid) || isProcessAlive(-pid);
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
      if (!groupAlive()) return true;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
  return !groupAlive();
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
