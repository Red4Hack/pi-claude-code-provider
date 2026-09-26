import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildClaudeEnvironment } from "./auth.ts";
import { providerModels } from "./catalog.ts";
import { bridgeArgv, bridgeLaunch, formatBridgeArgv } from "./claude-args.ts";
import { MODEL_ALIASES, type ModelAliasVersions } from "./claude-models.ts";
import type { VersionStatus } from "./compatibility.ts";
import { NEUTRAL_BUN_CONFIG, hostRuntimeDescription, needsBunConfig } from "./host-runtime.ts";
import { superviseProcess, terminateProcessGroup, type ProcessResult, type ProcessSupervisor } from "./process-utils.ts";
import { headText } from "./text.ts";
import { createRuntimeDirectory, recordRuntimeChild, removeRuntimeDirectory, type RuntimeCleanupResult } from "./runtime-directories.ts";
import type { ClaudeInstallation, RequestMetrics } from "./types.ts";

// Haiku 4.5 caches nothing below this, so a smaller request that reuses nothing
// says nothing about caching; see DEVELOPING.md#prompt-caching.
const MIN_CACHEABLE_PROMPT_TOKENS = 4_096;
// Below this a request has no earlier turn whose prefix it could have reused.
const MIN_REUSING_MESSAGE_COUNT = 3;
const LOW_CACHE_HIT_PERCENT = 50;

export interface BridgeProbeResult {
  ok: boolean;
  argv: string[];
  detail: string;
}

/**
 * Complete a real initialize plus tools/list handshake against the proposal bridge.
 * Version and path checks cannot detect a bridge that the hosting runtime refuses
 * to execute, which is exactly how the compiled standalone Pi build fails.
 */
export async function probeBridge(
  timeoutMs = 10_000,
  dependencies: { spawnChild?: typeof spawn; supervise?: typeof superviseProcess; temporaryRoot?: string } = {},
): Promise<BridgeProbeResult> {
  const directory = await createRuntimeDirectory("bridge_probe", { temporaryRoot: dependencies.temporaryRoot });
  let livenessUnknown = false;
  try {
    const catalogPath = join(directory, "catalog.json");
    const readyPath = join(directory, "ready");
    let bunConfigPath: string | undefined;
    if (needsBunConfig()) {
      bunConfigPath = join(directory, "bunfig.toml");
      await writeFile(bunConfigPath, NEUTRAL_BUN_CONFIG, { mode: 0o600 });
    }
    const launch = bridgeLaunch(bunConfigPath);
    const argv = bridgeArgv(bunConfigPath);
    await writeFile(catalogPath, JSON.stringify([{ name: "probe", description: "doctor probe", inputSchema: { type: "object" } }]), { mode: 0o600 });
    const child = (dependencies.spawnChild ?? spawn)(launch.command, launch.args, {
      cwd: directory,
      // Mirror what Claude Code actually hands the bridge: its own filtered
      // environment plus the server env from --mcp-config. A probe with a richer
      // environment than production could pass where a real request fails.
      env: buildClaudeEnvironment({
        ...launch.env,
        PI_CLAUDE_TOOL_CATALOG: catalogPath,
        PI_CLAUDE_TOOL_READY: readyPath,
      }),
      // Own a process group like every other spawn here: superviseProcess cleans
      // up with kill(-pid), which must never reach a group this child does not lead.
      detached: process.platform !== "win32",
      windowsHide: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let failure: string | undefined;
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = headText(stdout, chunk, 64 * 1024);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = headText(stderr, chunk, 4 * 1024);
    });
    let supervisor: ProcessSupervisor | undefined;
    let result: ProcessResult | undefined;
    let waitError: unknown;
    let terminationError: unknown;
    try {
      supervisor = (dependencies.supervise ?? superviseProcess)(child, {
        idleTimeoutMs: timeoutMs,
        totalTimeoutMs: timeoutMs,
        onFailure(error) {
          failure ??= error.message;
        },
      });
      await recordRuntimeChild(directory, child.pid as number);
      child.stdin?.end(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n` +
        `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`,
      );
      result = await supervisor.wait();
    } catch (error) {
      waitError = error;
    } finally {
      supervisor?.dispose();
      try {
        await (supervisor ? supervisor.terminate() : terminateProcessGroup(child));
      } catch (error) {
        terminationError = error;
        // The marker carries the child PID for stale recovery. Removing the
        // directory now could discard state a surviving descendant still uses.
        livenessUnknown = true;
      }
    }
    if (terminationError) return {
      ok: false, argv,
      detail: `process cleanup failed; liveness unknown: ${String(terminationError).slice(0, 256)}`,
    };
    if (waitError || failure || result?.error || result?.code !== 0 || result.signal !== null) {
      const exit = result ? `exit code ${String(result.code)}, signal ${String(result.signal)}` : "no exit result";
      const cause = waitError ?? failure ?? result?.error;
      return { ok: false, argv, detail: `bridge process failed (${exit})${cause ? `: ${String(cause).slice(0, 256)}` : ""}` };
    }
    const listed = stdout.split("\n").filter(Boolean).map((line) => {
      try {
        return JSON.parse(line) as { id?: unknown; result?: { tools?: unknown } };
      } catch {
        return undefined;
      }
    });
    const tools = listed.find((message) => message?.id === 2)?.result?.tools;
    const ready = await readFile(readyPath, "utf8").then(() => true, () => false);
    if (!Array.isArray(tools) || tools.length !== 1 || !ready) {
      const cause = failure ?? stderr.trim();
      return {
        ok: false,
        argv,
        detail: `handshake failed (${Array.isArray(tools) ? `${tools.length} tools` : "no tools/list result"}, ready marker ${ready ? "written" : "missing"})${cause ? `: ${cause.slice(0, 256)}` : ""}`,
      };
    }
    return { ok: true, argv, detail: "handshake completed: 1 tool listed, ready marker written" };
  } finally {
    if (!livenessUnknown) await removeRuntimeDirectory(directory);
  }
}

export interface DoctorSummaryInput {
  platformStatus: VersionStatus;
  piStatus: VersionStatus;
  claudeStatus: VersionStatus;
  installation: ClaudeInstallation;
  modelIds: readonly string[];
  modelVersions?: ModelAliasVersions;
  metrics?: RequestMetrics;
  metricsLogError?: string;
  runtimeCleanup: RuntimeCleanupResult;
  bridgeProbe?: BridgeProbeResult;
}

export function formatDoctorSummary(input: DoctorSummaryInput): string {
  const verification = [input.platformStatus, input.piStatus, input.claudeStatus]
    .map((status) => {
      const verified = status.isVerified ? "verified" : `unverified; tested ${status.verified}`;
      // A supported-version floor is a separate statement from the tested
      // baseline, so report it only when the install actually falls below it.
      const floor = status.meetsMinimum === false ? `; below minimum ${status.minimum}` : "";
      return `${status.component} ${status.current} (${verified}${floor})`;
    })
    .join("; ");
  const metrics = input.metrics;
  const reportedPromptTokens = metrics ? metrics.inputTokens + metrics.cacheRead + metrics.cacheWrite : 0;
  const reportedUsage =
    metrics && reportedPromptTokens > 0
      ? `reported usage: ${metrics.inputTokens} input, ${metrics.cacheRead} cache read, ${metrics.cacheWrite} cache write${metrics.cacheHitPercent === undefined ? "" : `, ${metrics.cacheHitPercent}% cache hit`}`
      : "reported token usage unavailable";
  // One labeled fact per line: this is read in a notification, not parsed.
  const lines = [
    verification,
    `Runtime: ${hostRuntimeDescription()}`,
    `Claude: ${input.installation.executable} (${input.installation.subscriptionType} subscription)`,
    `Models: ${input.modelIds.join(", ")}`,
  ];
  const servedModels = formatServedModels(input);
  if (servedModels) lines.push(`Served models (Claude Code install): ${servedModels}`);
  if (input.bridgeProbe) {
    lines.push(`Bridge: ${input.bridgeProbe.ok ? "ok" : "BROKEN"} via ${formatBridgeArgv(input.bridgeProbe.argv)} (${input.bridgeProbe.detail})`);
  }
  lines.push(metrics
    ? `Last request: ${metrics.requestedModel}/${metrics.effort}, ${metrics.messageCount} messages, ${metrics.estimatedInputTokens} estimated transport tokens, ${reportedUsage}, ${metrics.durationMs ?? 0}ms, ${metrics.stopReason ?? "unknown"}${metrics.errorCategory ? ` (${metrics.errorCategory})` : ""}${metrics.cleanupComplete ? "" : ", cleanup incomplete"}`
    : "Last request: no request metrics recorded yet");
  if (metrics) {
    const sources: Record<string, string> = {
      registered: "registered Pi session",
      prompt: "Pi prompt declaration",
      single: "sole-session compatibility borrow",
      oneshot: "tool-free newest-session borrow",
    };
    lines.push(`Working directory source: ${sources[metrics.sessionResolution ?? ""] ?? "unresolved"}`);
    const contextWindow = servedContextWindowNote(input, metrics);
    if (contextWindow) lines.push(contextWindow);
    const promptCache = promptCacheNote(metrics);
    if (promptCache) lines.push(promptCache);
  }
  if (input.metricsLogError) lines.push(`Metrics log error: ${input.metricsLogError}`);
  const cleanup = input.runtimeCleanup;
  if (cleanup.removed > 0 || cleanup.failures > 0 || cleanup.reaped > 0) {
    // An abandoned Claude process group is named only when one was reclaimed:
    // it explains both a freed machine and a spent subscription slot.
    const reaped = cleanup.reaped > 0
      ? `, ${cleanup.reaped} abandoned Claude ${cleanup.reaped === 1 ? "process" : "processes"} terminated`
      : "";
    lines.push(`Stale runtime cleanup: ${cleanup.removed} removed${reaped}, ${cleanup.failures} ${cleanup.failures === 1 ? "failure" : "failures"}`);
  }
  return lines.join("\n");
}

/**
 * Claude Code's own reported context window, when it has stopped matching the one
 * this package advertises. Only a mismatch is reported, because a match is the
 * ordinary case and says nothing. It is worth stating because Pi places its
 * compaction threshold by the *configured* value: a served window smaller than
 * that lets sessions grow until Claude Code refuses them as too long, and one
 * larger compacts sessions that still had room.
 */
function servedContextWindowNote(input: DoctorSummaryInput, metrics: RequestMetrics): string | undefined {
  const served = metrics.servedContextWindow;
  if (typeof served !== "number" || !Number.isFinite(served) || served <= 0) return undefined;
  const configured = providerModels()
    .find((model) => model.id === metrics.requestedModel)?.contextWindow;
  if (configured === undefined || configured === served) return undefined;
  return `Context window: ${metrics.requestedModel} served ${served}, configured ${configured}; ` +
    "Pi compacts by the configured value";
}

/**
 * Prompt-cache reuse that collapsed where it should have held. Losing reuse is
 * otherwise silent -- no error, just slower and more expensive turns -- so the
 * doctor states it rather than leaving a paid gate as the only detector. Reported
 * here only, deliberately never as a session notification.
 */
function promptCacheNote(metrics: RequestMetrics): string | undefined {
  const reused = metrics.cacheHitPercent;
  if (reused === undefined || reused >= LOW_CACHE_HIT_PERCENT) return undefined;
  if (metrics.messageCount < MIN_REUSING_MESSAGE_COUNT) return undefined;
  if (metrics.estimatedInputTokens < MIN_CACHEABLE_PROMPT_TOKENS) return undefined;
  return `Prompt cache: last request reused ${reused}% over ${metrics.messageCount} messages. ` +
    "One low reading is not evidence, and Pi's own summary requests never reuse; " +
    "repeat it before concluding caching is broken";
}

/**
 * Name the concrete model each alias would be served. Fable needs a caveat on
 * Pro: `claude auth status` exposes no usage-credit field, so this reports what
 * the install would serve without implying it knows whether credits are on.
 */
function formatServedModels(input: DoctorSummaryInput): string {
  const versions = input.modelVersions;
  if (!versions) return "";
  const advertised = MODEL_ALIASES.filter((alias) => input.modelIds.includes(alias));
  if (advertised.length === 0) return "";
  const entries = advertised.map((alias) => {
    const model = versions[alias];
    if (model === undefined) return `${alias} undetermined`;
    const caveat = alias === "fable" && input.installation.subscriptionType === "pro"
      ? " (Pro: requires usage credits enabled)"
      : "";
    return `${alias} ${model}${caveat}`;
  });
  return entries.join(", ");
}
