import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, VERSION, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { inspectClaudeInstallation } from "../src/auth.ts";
import { providerModels as catalogModels } from "../src/catalog.ts";
import { bridgeArgv } from "../src/claude-args.ts";
import { readClaudeModelAliases } from "../src/claude-models.ts";
import { MINIMUM_VERSIONS, VERIFIED_VERSIONS, platformStatus, startupPlatformWarning, versionStatus } from "../src/compatibility.ts";
import { writeDiagnosticReport } from "../src/diagnostics.ts";
import { errorText, normalizeClaudeOverflow } from "../src/errors.ts";
import { formatDoctorSummary, probeBridge } from "../src/doctor.ts";
import { flushMetricsLog, getLastRequestMetrics, getLastSearchMetrics, getMetricsLogError } from "../src/metrics.ts";
import { createClaudeStream } from "../src/provider.ts";
import { cleanupStaleRuntimeDirectories, createRuntimeDirectory } from "../src/runtime-directories.ts";
import { SessionImageStore } from "../src/session-image-store.ts";
import { resolveSession, sessionRegistry } from "../src/session-registry.ts";
import { searchWithClaude } from "../src/web-search.ts";
import type { RateLimitNotice } from "../src/claude-protocol.ts";
import type { RuntimeCleanupResult } from "../src/runtime-directories.ts";
import type { ClaudeInstallation } from "../src/types.ts";

const PROVIDER = "pi-claude-code-provider";
const API = "pi-claude-code-provider-headless";
const SEARCH_TOOL = "pi_claude_code_provider_web_search";
const NOTICE_PREFIX = "[pi-claude-code-provider]";
const MAX_TRACKED_RATE_LIMIT_NOTICES = 64;

export default async function piClaudeCodeProvider(pi: ExtensionAPI): Promise<void> {
  const runtimeCleanup = await cleanupStaleRuntimeDirectories();
  registerDoctorCommand(pi, runtimeCleanup);

  let installation: ClaudeInstallation;
  try {
    installation = await inspectClaudeInstallation();
  } catch (error) {
    registerUnavailableNotice(pi, errorText(error));
    return;
  }
  const providerModels = catalogModels();
  const currentPlatform = platformStatus();
  const searchOutputs = createSearchOutputOwner();
  const imageStore = new SessionImageStore();
  let searchRegistrationAttempted = false;
  let activeRateLimitNotify: ((notice: RateLimitNotice) => void) | undefined;
  // Sessions are registered process-wide, not in this closure: Pi re-runs this
  // factory for every new, resumed, forked or cloned session, and a host can hold
  // several live sessions that share these instances. A request must resolve its
  // own session's directory, image store and notifier, never the last to register,
  // because Pi's model runtime keeps only the newest provider.
  const sessions = sessionRegistry();
  let ownSessionId: string | undefined;

  const streamSimple = createClaudeStream(installation, {
    resolveSession: (request) => resolveSession(sessions, {
      ...request,
      allowBorrowSoleDirectory: process.env.PI_CLAUDE_CODE_PROVIDER_BORROW_SOLE_DIRECTORY?.trim() === "on",
    }),
  });
  pi.registerProvider(PROVIDER, {
    name: "Claude Code Subscription",
    baseUrl: "pi-claude-code-provider://local",
    apiKey: "pi-claude-code-provider-subscription",
    api: API,
    models: providerModels,
    streamSimple,
  });
  // Pi's own registerProvider populates its model runtime only. Pi-AI's
  // completeSimple and stream resolve the model's api in Pi-AI's registry
  // instead, and Pi's provider composer falls back to that registry too, so a
  // miss threw "No API provider registered", which Pi's unawaited loop turns into
  // an unhandled rejection that exits it. Side requests pass their own prompt and
  // tools, but a tool-bearing direct Agent must also identify its cwd; its own
  // tools run outside Claude and may use another directory.
  //
  // Loaded rather than imported: Pi-AI declares this entrypoint temporary and
  // slated for deletion, and a static import would take the whole extension down
  // with it, because resolution fails before this factory runs and even the
  // unavailable notice never reports. Without it the user keeps the provider and
  // loses only side requests from other extensions.
  const compat = await import("@earendil-works/pi-ai/compat").catch(() => undefined);
  const serveApiRegistry = (): void => {
    if (!compat || compat.getApiProvider(API)) return;
    compat.registerApiProvider({ api: API, stream: streamSimple, streamSimple }, PROVIDER);
  };
  serveApiRegistry();

  pi.on("session_start", (_event, ctx) => {
    searchOutputs.open();
    imageStore.open();
    // Another session reloading clears Pi-AI's registry for every extension in
    // the process, so ownership is re-asserted rather than claimed once.
    serveApiRegistry();
    // The provider starts a process per tool round-trip; session scope prevents
    // Claude's repeated notice from surfacing throughout one Pi turn.
    activeRateLimitNotify = createRateLimitNotifier((message) => ctx.ui.notify(message, "warning"));
    // Pi's session directory, not process.cwd(): a resumed session takes its cwd
    // from the session file, and Pi's tools resolve paths against that one.
    //
    // Every step of this handler is idempotent, because Pi's RPC mode binds
    // extensions twice for one session: its runtime rebinds on a new, resumed,
    // forked or cloned session and the command handler then rebinds again, so
    // `session_start` arrives twice with no shutdown between. Dropping the earlier
    // id is what keeps that second bind from orphaning the first one's entry.
    if (ownSessionId !== undefined) sessions.delete(ownSessionId);
    ownSessionId = ctx.sessionManager.getSessionId();
    sessions.set(ownSessionId, {
      cwd: ctx.cwd,
      imageStore,
      onRateLimitNotice: (notice) => activeRateLimitNotify?.(notice),
    });
    const platformWarning = startupPlatformWarning(currentPlatform);
    if (platformWarning) ctx.ui.notify(`${NOTICE_PREFIX} ${platformWarning}`, "warning");
    if (searchRegistrationAttempted) return;
    searchRegistrationAttempted = true;
    registerWebSearchTool(
      pi,
      installation,
      searchOutputs.retain,
      (notice) => activeRateLimitNotify?.(notice),
      (message) => ctx.ui.notify(message, "warning"),
    );
  });

  pi.on("session_shutdown", async () => {
    activeRateLimitNotify = undefined;
    // Only this instance's own entry: another instance's sessions stay live.
    if (ownSessionId !== undefined) sessions.delete(ownSessionId);
    ownSessionId = undefined;
    // The registration is shared, so it outlives whichever instance made it and
    // is withdrawn only once no session is left to serve.
    if (sessions.size === 0) compat?.unregisterApiProviders(PROVIDER);
    try {
      await Promise.all([searchOutputs.close(), imageStore.close()]);
    } finally {
      await flushMetricsLog();
    }
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant" || message.stopReason !== "error") return;
    const assistant = message as AssistantMessage;
    if (assistant.provider !== PROVIDER && ctx.model?.provider !== PROVIDER) return;
    const errorMessage = assistant.errorMessage ?? "";
    const normalized = normalizeClaudeOverflow(errorMessage);
    if (normalized === errorMessage) return;
    return { message: { ...assistant, errorMessage: normalized } };
  });
}

function registerDoctorCommand(pi: ExtensionAPI, runtimeCleanup: RuntimeCleanupResult): void {
  pi.registerCommand("pi-claude-code-provider-doctor", {
    description: "Check Claude Code compatibility or write a diagnostic report",
    handler: async (args, ctx) => {
      try {
        const command = args.trim();
        if (command && command !== "report") {
          ctx.ui.notify("Usage: /pi-claude-code-provider-doctor [report]", "error");
          return;
        }
        const currentPlatform = platformStatus();
        const piStatus = versionStatus("Pi", VERSION, VERIFIED_VERSIONS.pi, MINIMUM_VERSIONS.pi);
        // Version and path checks can pass even when the proposal bridge cannot
        // start, so prove it with a real dependency-free handshake.
        const bridgeProbe = await probeBridge().catch((error: unknown) => ({
          ok: false,
          argv: bridgeArgv(),
          detail: errorText(error),
        }));
        if (command === "report") {
          let current: ClaudeInstallation | undefined;
          let preflightError: unknown;
          try { current = await inspectClaudeInstallation(); } catch (error) { preflightError = error; }
          const modelVersions = current ? await readClaudeModelAliases(current).catch(() => undefined) : undefined;
          const path = await writeDiagnosticReport({
            platformStatus: currentPlatform,
            piStatus,
            claudeStatus: current ? versionStatus("Claude Code", current.version, VERIFIED_VERSIONS.claudeCode, MINIMUM_VERSIONS.claudeCode) : undefined,
            installation: current,
            modelVersions,
            preflightError,
            metrics: getLastRequestMetrics(),
            searchMetrics: getLastSearchMetrics(),
            metricsLogError: getMetricsLogError(),
            runtimeCleanup,
            bridgeProbe,
          });
          ctx.ui.notify(
            `Claude Code diagnostic report written to ${path}${preflightError ? "; preflight failed, so installation details may be incomplete" : ""}`,
            preflightError ? "warning" : "info",
          );
          return;
        }
        const current = await inspectClaudeInstallation();
        const claudeStatus = versionStatus("Claude Code", current.version, VERIFIED_VERSIONS.claudeCode, MINIMUM_VERSIONS.claudeCode);
        ctx.ui.notify(formatDoctorSummary({
          platformStatus: currentPlatform,
          piStatus,
          claudeStatus,
          installation: current,
          modelIds: catalogModels().map((model) => model.id),
          // Diagnostic only, and fail-soft: a doctor run must never fail
          // because Claude Code moved an undocumented internal table.
          modelVersions: await readClaudeModelAliases(current).catch(() => undefined),
          metrics: getLastRequestMetrics(),
          metricsLogError: getMetricsLogError(),
          runtimeCleanup,
          bridgeProbe,
        }), bridgeProbe.ok && claudeStatus.isVerified && piStatus.isVerified && currentPlatform.isVerified ? "info" : "warning");
      } catch (error) {
        ctx.ui.notify(errorText(error), "error");
      }
    },
  });
}

function createRateLimitNotifier(notify: (message: string) => void): (notice: RateLimitNotice) => void {
  const emitted = new Set<string>();
  return (notice) => {
    // Key on the displayed text: utilization arrives as a fraction that changes
    // between events while the notice shows whole percent, so keying on the raw
    // notice would repeat an identical-looking warning on every round trip.
    const message = formatRateLimitNotice(notice);
    if (emitted.has(message)) return;
    if (emitted.size >= MAX_TRACKED_RATE_LIMIT_NOTICES) {
      const [oldest] = emitted;
      if (oldest !== undefined) emitted.delete(oldest);
    }
    emitted.add(message);
    notify(message);
  };
}

function createSearchOutputOwner() {
  let closing = true;
  const retained = new Set<string>();
  const pending = new Set<Promise<{ directory: string; path: string } | undefined>>();
  const retain = (result: string): Promise<{ directory: string; path: string } | undefined> => {
    if (closing) return Promise.resolve(undefined);
    const retention = (async () => {
      const directory = await createRuntimeDirectory("web_search_output");
      const path = join(directory, "result.md");
      try {
        await writeFile(path, result, { mode: 0o600, flag: "wx" });
        if (closing) {
          await rm(directory, { recursive: true, force: true });
          return undefined;
        }
        retained.add(directory);
        return { directory, path };
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
    })();
    // Track before awaiting anything so shutdown owns a directory whose
    // asynchronous creation has begun but has not completed.
    pending.add(retention);
    void retention.finally(() => pending.delete(retention)).catch(() => undefined);
    return retention;
  };
  return {
    open: () => { closing = false; },
    retain,
    async close(): Promise<void> {
      closing = true;
      await Promise.allSettled([...pending]);
      while (retained.size > 0) {
        const directories = [...retained];
        retained.clear();
        await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
      }
    },
  };
}

function registerWebSearchTool(
  pi: ExtensionAPI,
  installation: ClaudeInstallation,
  retainOutput: (result: string) => Promise<{ directory: string; path: string } | undefined>,
  onRateLimitNotice: (notice: RateLimitNotice) => void,
  notify: (message: string) => void,
): void {
  if (pi.getAllTools().some((tool) => tool.name === SEARCH_TOOL)) {
    notify(`${NOTICE_PREFIX} ${SEARCH_TOOL} was not registered because that tool name is already occupied`);
    return;
  }
  pi.registerTool({
    name: SEARCH_TOOL,
    label: "Web Search",
    description: `Search the current web through Claude Code and return a concise synthesis with source URLs. Output is truncated to ${formatSize(DEFAULT_MAX_BYTES)} or ${DEFAULT_MAX_LINES} lines.`,
    promptSnippet: "Search the current web and return sourced results",
    promptGuidelines: [`Use ${SEARCH_TOOL} when current external information or online sources are required.`],
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "Search query" }),
      focus: Type.Optional(Type.String({ description: "Optional guidance about what to prioritize" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: `Searching the web for: ${params.query}` }], details: { status: "searching" } });
      const result = await searchWithClaude(
        installation,
        { query: params.query, focus: params.focus, signal },
        { onRateLimitNotice },
      );
      const truncated = truncateHead(result, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
      let text = truncated.content;
      let fullOutputPath: string | undefined;
      if (truncated.truncated) {
        const output = await retainOutput(result);
        if (output) {
          fullOutputPath = output.path;
          text += `\n\n[Web-search output truncated to ${truncated.outputLines} of ${truncated.totalLines} lines (${formatSize(truncated.outputBytes)} of ${formatSize(truncated.totalBytes)}). Full output: ${fullOutputPath}]`;
        }
      }
      return { content: [{ type: "text", text }], details: { truncated: truncated.truncated, fullOutputPath } };
    },
  });
}

/**
 * Claude reports an absolute reset instant, and windows run as long as seven
 * days, so a bare wall-clock time is ambiguous rather than merely terse.
 */
function formatResetInstant(resetsAt: number): string {
  return new Date(resetsAt).toLocaleString();
}

function formatRateLimitNotice(notice: RateLimitNotice): string {
  const reset = notice.resetsAt === undefined
    ? ""
    : `; resets at ${formatResetInstant(notice.resetsAt)}`;
  // An overage-typed notice reports the overage reset as its primary reset, so
  // the mapper never supplies a separate overage reset in that case.
  const overageReset = notice.overageResetsAt === undefined
    ? ""
    : `; overage resets at ${formatResetInstant(notice.overageResetsAt)}`;
  const overage = notice.overageStatus === undefined
    ? ""
    : `; overage ${notice.overageStatus}${notice.overageDisabledReason ? ` (${notice.overageDisabledReason})` : ""}`;
  const usingOverage = notice.isUsingOverage ? "; using overage" : "";
  if (notice.status === "rejected") {
    return `${NOTICE_PREFIX} Claude rate limited (${notice.rateLimitType})${reset}${overageReset}${overage}${usingOverage}`;
  }
  const usage = notice.utilization === undefined
    ? "usage is approaching the limit"
    : `${Math.floor(notice.utilization * 100)}% used`;
  // Match Claude Code's current whole-percent display while preserving the
  // fractional utilization in the protocol mapper for future consumers.
  return `${NOTICE_PREFIX} Claude rate limit warning: ${usage} (${notice.rateLimitType})${reset}${overageReset}${overage}${usingOverage}`;
}

function registerUnavailableNotice(pi: ExtensionAPI, reason: string): void {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify(
      `${NOTICE_PREFIX} Claude Code provider is unavailable: ${reason}. Run /pi-claude-code-provider-doctor, then /reload after correcting the problem.`,
      "error",
    );
  });
}
