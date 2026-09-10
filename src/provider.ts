import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  ProviderResponse,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { buildClaudeEnvironment, claudeLaunch } from "./auth.ts";
import { bridgeArgv, formatBridgeArgv, providerArgs } from "./claude-args.ts";
import { MAX_SYSTEM_PROMPT_BYTES, prepareRequest } from "./context-serializer.ts";
import { appendCleanupFailure, ClaudeCodeError, errorText } from "./errors.ts";
import { JsonlParser } from "./jsonl.ts";
import { recordRequestMetrics } from "./metrics.ts";
import { createOutput } from "./output.ts";
import { claimPaidTestLaunch } from "./paid-launch-budget.ts";
import { ProcessTerminationError, superviseProcess, terminateProcessGroup, type ProcessSupervisor } from "./process-utils.ts";
import { recordRuntimeChild, removeRuntimeDirectory } from "./runtime-directories.ts";
import { tailText } from "./text.ts";
import type { RateLimitNoticeSink } from "./claude-protocol.ts";
import { ClaudeEventMapper, type ClaudeTerminationCause } from "./stream-events.ts";
import type { ClaudeInstallation, LogicalProviderPayload, MutableOutput, RequestMetrics } from "./types.ts";

const MAX_STDERR_BYTES = 64 * 1024;
// Claude Code connects the proposal server during its own startup, which is
// about a second on a warm machine but is bounded by process start, settings
// resolution, and authentication. Five seconds turned an ordinary slow start
// into a failed request, so allow real headroom; a bridge that cannot launch
// still fails on the process-exit branch below rather than on this deadline.
const DEFAULT_MCP_READY_TIMEOUT_MS = 20_000;
// Bound the stderr excerpt carried into a readiness failure; the full stream is
// already capped, and an error message is not a log.
const READY_STDERR_BYTES = 1_000;
/**
 * Reasoning room Pi expects on top of a requested output cap, mirroring
 * `DEFAULT_THINKING_BUDGETS` and `clampReasoning` in pi-ai: Pi treats
 * `maxTokens` as the budget for the answer and adds the thinking budget to the
 * response ceiling, because thinking is output too. This transport always asks
 * Claude Code for an effort level, so it always owes the answer that room.
 */
const THINKING_BUDGET_TOKENS: Readonly<Record<string, number>> = Object.freeze({
  minimal: 1_024,
  low: 2_048,
  medium: 8_192,
  high: 16_384,
  xhigh: 16_384,
  max: 16_384,
});
/**
 * Pi's own context safety margin, covering what no estimate here can see:
 * Claude Code adds its own system prompt, MCP tool schemas, and reminders to
 * every request. Bounded by a tenth of the window so a small-context model is
 * not declared full by the margin alone.
 */
const CONTEXT_SAFETY_TOKENS = 4_096;
/** Pi's floor for an answer that shares a response ceiling with reasoning. */
const MIN_ANSWER_TOKENS = 1_024;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 30 * 60_000;
/** Internal dependency seam for deterministic cleanup-failure tests. */
type CleanupDirectory = (directory: string) => Promise<void>;

/** Internal dependency seam for deterministic abort-timing tests. */
type ClaimLaunch = () => Promise<void>;

export interface ClaudeStreamDependencies {
  cleanupDirectory?: CleanupDirectory;
  onRateLimitNotice?: RateLimitNoticeSink;
  claimLaunch?: ClaimLaunch;
  supervise?: typeof superviseProcess;
}

export function createClaudeStream(
  installation: ClaudeInstallation,
  dependencies: ClaudeStreamDependencies = {},
) {
  const cleanupDirectory = dependencies.cleanupDirectory ?? removeRuntimeDirectory;
  const onRateLimitNotice = dependencies.onRateLimitNotice;
  const claimLaunch = dependencies.claimLaunch ?? claimPaidTestLaunch;
  const supervise = dependencies.supervise ?? superviseProcess;
  return (model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    const output = createOutput(model);

    void (async () => {
      const startedAt = Date.now();
      const effort = options?.reasoning ?? "medium";
      let prepared: Awaited<ReturnType<typeof prepareRequest>> | undefined;
      let child: ReturnType<typeof spawn> | undefined;
      let supervisor: ProcessSupervisor | undefined;
      let abortHandler: (() => void) | undefined;
      let toolUse = false;
      let terminationCause: ClaudeTerminationCause = "none";
      let stderr = "";
      let mapper: ClaudeEventMapper | undefined;
      let exitCode: number | null | undefined;
      let exitSignal: NodeJS.Signals | null | undefined;
      let errorCategory: string | undefined;
      let terminationFailure: unknown;
      let processLivenessUnknown = false;
      let finalized = false;
      const metrics: RequestMetrics = {
        schemaVersion: 4,
        timestamp: new Date(startedAt).toISOString(),
        platform: process.platform,
        architecture: process.arch,
        nodeVersion: process.version,
        claudeVersion: installation.version,
        requestedModel: model.id,
        effort,
        messageCount: context.messages.length,
        toolCount: context.tools?.length ?? 0,
        imageCount: 0,
        transcriptBytes: 0,
        catalogBytes: 0,
        imageBytes: 0,
        estimatedInputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        inputTokens: 0,
        outputTokens: 0,
        lastPhase: "received",
        cleanupComplete: true,
        terminationExpected: false,
      };

      const cleanupPrepared = async (): Promise<void> => {
        if (!prepared || processLivenessUnknown) return;
        const current = prepared;
        await cleanupDirectory(current.directory);
        metrics.cleanupComplete = true;
        if (prepared === current) prepared = undefined;
      };

      const failureAfterCleanup = async (failure: string): Promise<string> => {
        try {
          await cleanupPrepared();
          return failure;
        } catch (cleanupError) {
          return appendCleanupFailure(failure, "private request", cleanupError);
        }
      };

      const terminateCurrent = async (): Promise<void> => {
        try {
          if (supervisor) await supervisor.terminate();
          else if (child) await terminateProcessGroup(child);
        } catch (error) {
          terminationFailure ??= error;
          throw error;
        }
      };

      const terminateInBackground = (): void => {
        void terminateCurrent().catch(() => {
          errorCategory ??= "process_cleanup";
          // The shared supervisor rejects wait() promptly on this same failure;
          // the main catch path owns the complete, non-duplicated user message.
        });
      };

      // Claude Code's headless protocol has no HTTP response to report, so a
      // validated initialization is announced with a synthetic success status
      // and no headers. Pi requires that an asynchronous observer finish
      // before its response body is mapped or published.
      const announceResponse = async (): Promise<void> => {
        const observe = options?.onResponse;
        if (!observe) return;
        const response: ProviderResponse = { status: 200, headers: {} };
        try {
          await observe(response, model);
        } catch (error) {
          errorCategory ??= "response_hook";
          throw new ClaudeCodeError("response_hook", `Pi after_provider_response handler failed: ${errorText(error)}`);
        }
      };

      const stopForToolUse = (): void => {
        if (toolUse || terminationCause === "caller_abort") return;
        toolUse = true;
        terminationCause = "tool_handoff";
        metrics.terminationExpected = true;
        terminateInBackground();
      };

      const finalizeLifecycle = async (): Promise<void> => {
        if (finalized) return;
        finalized = true;
        // Terminal stream publication belongs to the protocol boundary below;
        // this idempotent finalizer owns only request resources and metrics.
        if (abortHandler) options?.signal?.removeEventListener("abort", abortHandler);
        supervisor?.dispose();
        try {
          await cleanupPrepared();
        } catch {
          errorCategory ??= "cleanup";
        }
        metrics.durationMs = Date.now() - startedAt;
        metrics.resolvedModel = output.responseModel;
        metrics.servedContextWindow = mapper?.contextWindow;
        metrics.servedMaxOutputTokens = mapper?.maxOutputTokens;
        metrics.cacheRead = output.usage.cacheRead;
        metrics.cacheWrite = output.usage.cacheWrite;
        metrics.inputTokens = output.usage.input;
        metrics.outputTokens = output.usage.output;
        // Cache-hit percentage is cache reads divided by Claude's complete
        // reported prompt usage, including new input and cache writes.
        const promptTokens = metrics.inputTokens + metrics.cacheRead + metrics.cacheWrite;
        metrics.cacheHitPercent = promptTokens > 0 ? Math.round((metrics.cacheRead * 10_000) / promptTokens) / 100 : undefined;
        metrics.stopReason = output.stopReason;
        metrics.errorCategory =
          errorCategory ?? (mapper?.rateLimitFailure ? "rate_limit" : output.stopReason === "error" ? "claude_error" : undefined);
        metrics.exitCode = exitCode;
        metrics.exitSignal = exitSignal;
        recordRequestMetrics(metrics);
      };

      try {
        // Phase 1 — prepare Pi's logical payload and private transport state.
        const effectiveContext = await applyPayloadHook(model, context, options);
        metrics.lastPhase = "payload_applied";
        metrics.messageCount = effectiveContext.messages.length;
        metrics.toolCount = effectiveContext.tools?.length ?? 0;
        const systemPromptBytes = Buffer.byteLength(effectiveContext.systemPrompt ?? "");
        if (systemPromptBytes > MAX_SYSTEM_PROMPT_BYTES) {
          throw new ClaudeCodeError(
            "system_prompt_size",
            `Pi system prompt is ${systemPromptBytes} bytes; the supported limit is ${MAX_SYSTEM_PROMPT_BYTES}`,
          );
        }
        prepared = await prepareRequest(effectiveContext);
        metrics.cleanupComplete = false;
        metrics.lastPhase = "prepared";
        const estimatedInputTokens = estimateTransportTokens(
          prepared.transcriptBytes,
          prepared.catalogBytes,
          systemPromptBytes,
          prepared.attachmentPaths.length,
        );
        metrics.imageCount = prepared.attachmentPaths.length;
        metrics.transcriptBytes = prepared.transcriptBytes;
        metrics.catalogBytes = prepared.catalogBytes;
        metrics.imageBytes = prepared.imageBytes;
        metrics.estimatedInputTokens = estimatedInputTokens;
        const maxOutputTokens = availableOutputTokens(model, estimatedInputTokens, options?.maxTokens, effort);
        const { args, prompt } = providerArgs(prepared, model.id, effort);
        const expectedTools = new Set(prepared.toolNames.keys());
        mapper = new ClaudeEventMapper({
          stream,
          output,
          expectedTools,
          toolNames: prepared.toolNames,
          onToolUse: stopForToolUse,
          onRateLimitNotice,
          onResponseAnnouncement: announceResponse,
          privatePaths: [prepared.directory],
        });

        // Configuration must fail before a paid budget slot is claimed or a
        // Claude process is spawned.
        const configuredTotal = timeoutSetting("PI_CLAUDE_CODE_PROVIDER_TOTAL_TIMEOUT_MS", DEFAULT_TOTAL_TIMEOUT_MS);
        const requestedTotal = options?.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : configuredTotal;
        const totalTimeoutMs = Math.min(requestedTotal, configuredTotal);
        const idleTimeoutMs = Math.min(
          timeoutSetting("PI_CLAUDE_CODE_PROVIDER_IDLE_TIMEOUT_MS", DEFAULT_IDLE_TIMEOUT_MS),
          totalTimeoutMs,
        );
        const readyTimeoutMs = Math.min(
          timeoutSetting("PI_CLAUDE_CODE_PROVIDER_MCP_READY_TIMEOUT_MS", DEFAULT_MCP_READY_TIMEOUT_MS),
          totalTimeoutMs,
        );

        // Phase 2 — claim the launch, spawn Claude, and record exact ownership.
        // Pi can cancel before asynchronous request preparation finishes. Do
        // not briefly launch Claude or its MCP child for an already-dead turn;
        // the finally path still removes the prepared private directory.
        if (options?.signal?.aborted) {
          errorCategory = "aborted";
          mapper.fail("Claude Code request was aborted", true);
          return;
        }

        await claimLaunch();
        // The claim can suspend, and an abort while it was pending has no
        // listener yet; re-check so a dead turn never pays for a spawn.
        if (options?.signal?.aborted) {
          errorCategory = "aborted";
          mapper.fail("Claude Code request was aborted", true);
          return;
        }
        const launch = claudeLaunch(installation.executable, args);
        child = spawn(launch.command, launch.args, {
          cwd: prepared.directory,
          env: buildClaudeEnvironment({
            ...launch.env,
            CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutputTokens),
            ...(prepared.catalogPath ? { PI_CLAUDE_TOOL_CATALOG: prepared.catalogPath } : {}),
          }),
          detached: process.platform !== "win32",
          windowsHide: process.platform === "win32",
          stdio: ["pipe", "pipe", "pipe"],
        });
        metrics.lastPhase = "spawned";
        supervisor = supervise(child, {
          idleTimeoutMs,
          totalTimeoutMs,
          onFailure(error) {
            if (error instanceof ProcessTerminationError) errorCategory = "process_cleanup";
            else errorCategory ??= "process";
            mapper?.fail(error.message, options?.signal?.aborted === true);
          },
        });

        // Register cancellation before any further await so no abort can land
        // between the spawn and its listener.
        abortHandler = (): void => {
          terminationCause = "caller_abort";
          errorCategory = "aborted";
          metrics.terminationExpected = true;
          mapper?.fail("Claude Code request was aborted", true);
          terminateInBackground();
        };
        options?.signal?.addEventListener("abort", abortHandler, { once: true });
        if (options?.signal?.aborted) abortHandler();

        await recordRuntimeChild(prepared.directory, child.pid ?? 0);

        // Phase 3 — consume and validate Claude's ordered JSONL protocol.
        let recordProcessing = Promise.resolve();
        const failProtocol = (error: unknown): void => {
          if (mapper?.isTerminal) return;
          errorCategory ??= error instanceof ClaudeCodeError ? error.code : "protocol";
          mapper?.fail(errorText(error));
          terminateInBackground();
        };
        const parser = new JsonlParser((value) => {
          recordProcessing = recordProcessing
            .then(async () => {
              if (mapper?.isTerminal) return;
              supervisor?.touch();
              mapper?.accept(value, terminationCause);
              await mapper?.settleResponseAnnouncement();
            })
            .catch((error: unknown) => failProtocol(error));
        });
        let resolveStdout: (() => void) | undefined;
        const stdoutDone = new Promise<void>((resolve) => {
          resolveStdout = resolve;
        });
        let stdoutFinished = false;
        const finishStdout = (): void => {
          if (stdoutFinished) return;
          stdoutFinished = true;
          try {
            parser.end();
          } catch (error) {
            failProtocol(error);
          }
          void recordProcessing.then(
            () => resolveStdout?.(),
            () => resolveStdout?.(),
          );
        };
        child.stdout?.on("data", (chunk: Buffer) => {
          try {
            parser.push(chunk);
          } catch (error) {
            failProtocol(error);
          }
        });
        child.stdout?.on("end", finishStdout);
        child.stdout?.once("close", finishStdout);
        if (!child.stdout) finishStdout();
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr = tailText(stderr, chunk, MAX_STDERR_BYTES);
        });

        if (prepared.readyPath) {
          const currentMapper = mapper;
          await waitForReadyOrExit(prepared.readyPath, readyTimeoutMs, options?.signal, supervisor.wait(), {
            bridgeArgv: bridgeArgv(prepared.bunConfigPath),
            stderr: () => stderr,
            // Claude's validated init record proves the server connected, and a
            // published failure has already decided the request. Either one ends
            // the wait, so a slow marker cannot mask the answer Claude already gave.
            settled: () => currentMapper.isInitialized || currentMapper.isTerminal,
          });
          metrics.lastPhase = "mcp_ready";
        }
        if (!mapper.isTerminal && child.exitCode === null && child.signalCode === null && !options?.signal?.aborted) {
          child.stdin?.end(
            `${JSON.stringify({
              type: "user",
              message: { role: "user", content: prompt },
            })}\n`,
          );
        }

        const result = await supervisor.wait();
        await stdoutDone;
        await new Promise<void>((resolve) => setImmediate(resolve));
        exitCode = result.code;
        exitSignal = result.signal;
        metrics.lastPhase = "process_exited";
        await terminateCurrent();

        // Phase 4 — validate the exit and private state before publishing success.
        if (toolUse) {
          if (prepared.violationPath && (await pathExists(prepared.violationPath))) {
            errorCategory = "mcp_execution";
            mapper.fail(
              await failureAfterCleanup(
                "Security invariant violated: Claude Code attempted to execute a Pi proposal tool internally",
              ),
            );
          } else if (containsPrivateTransportToolArgument(output, prepared.directory)) {
            errorCategory = "private_transport";
            mapper.fail(
              await failureAfterCleanup("Claude Code proposed a Pi tool call against provider-private transport state"),
            );
          } else if (mapper.isTerminal) {
            await cleanupPrepared();
          } else if (!isExpectedToolHandoffExit(result)) {
            errorCategory = "process_exit";
            mapper.fail(
              await failureAfterCleanup(
                `Claude Code tool handoff exited unexpectedly (code ${String(result.code)}, signal ${String(result.signal)})`,
              ),
            );
          } else {
            await cleanupPrepared();
            if (mapper.completeToolUse()) metrics.lastPhase = "completed";
          }
        } else if (mapper.hasSuccessfulResult) {
          if (result.code !== 0 || result.signal !== null) {
            errorCategory ??= "process_exit";
            const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
            mapper.fail(
              await failureAfterCleanup(
                `Claude Code exited after a successful result (code ${String(result.code)}, signal ${String(result.signal)})${detail}`,
              ),
            );
          } else {
            await cleanupPrepared();
            if (mapper.completeResult()) metrics.lastPhase = "completed";
          }
        } else if (!mapper.isTerminal) {
          errorCategory ??= mapper.rateLimitFailure ? "rate_limit" : "process_exit";
          const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
          mapper.fail(
            await failureAfterCleanup(
              mapper.rateLimitFailure ??
                `Claude Code exited before a terminal event (code ${String(result.code)}, signal ${String(result.signal)})${detail}`,
            ),
          );
        }
      } catch (error) {
        if (error instanceof ProcessTerminationError) {
          processLivenessUnknown = true;
          errorCategory = "process_cleanup";
        } else errorCategory ??= error instanceof ClaudeCodeError
          ? error.code
          : options?.signal?.aborted
            ? "aborted"
            : error === terminationFailure
              ? "process_cleanup"
              : "provider";
        let failure = errorText(error);
        if (error instanceof ProcessTerminationError) {
          failure += "; provider-private runtime state was retained because process death could not be established";
        }
        if (!(error instanceof ProcessTerminationError)) {
          try {
            await terminateCurrent();
          } catch (terminationError) {
            if (terminationError instanceof ProcessTerminationError) processLivenessUnknown = true;
            if (terminationError !== error) {
              failure = appendCleanupFailure(failure, "Claude Code process tree", terminationError);
            }
          }
        }
        try {
          await cleanupPrepared();
        } catch (cleanupError) {
          errorCategory ??= "cleanup";
          failure = appendCleanupFailure(failure, "private request", cleanupError);
        }
        if (mapper) {
          if (mapper.isTerminal) {
            // A consumer may already have observed this terminal (notably on
            // abort), so the append is best-effort; finalized metrics are the
            // authoritative cleanup-status record.
            output.errorMessage = output.errorMessage ? `${output.errorMessage}; ${failure}` : failure;
          }
          else mapper.fail(failure, options?.signal?.aborted === true);
        }
        else {
          output.stopReason = options?.signal?.aborted ? "aborted" : "error";
          output.errorMessage = failure;
          stream.push({ type: "error", reason: output.stopReason, error: output });
          stream.end();
        }
      } finally {
        await finalizeLifecycle();
      }
    })();

    return stream;
  };
}

export function isExpectedToolHandoffExit(
  result: { code: number | null; signal: NodeJS.Signals | null },
  platform: NodeJS.Platform = process.platform,
): boolean {
  // A correlated provider-owned handoff closes as code 143 on POSIX. Windows
  // taskkill /F closes the owned Claude root as code 1. These codes are accepted
  // only from the tool-handoff path after cleanup and proposal validation.
  if (result.signal !== null) return false;
  return platform === "win32" ? result.code === 1 : result.code === 143;
}

function timeoutSetting(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ClaudeCodeError("timeout_config", `${name} must be a positive integer number of milliseconds`);
  }
  return value;
}

/**
 * Pre-launch estimate: 2.4 bytes per token plus 10% margin and a flat per-image
 * reserve. The ratio is calibrated, not guessed. Measured against a real
 * session transcript by comparing this transport's serialized bytes with
 * Claude's own reported prompt counters (input + cacheRead + cacheWrite) over
 * the same messages, dense agent history tokenized at 2.12 bytes per token —
 * JSON structure, escaped characters, file paths, and code all tokenize far
 * below prose. The previous 3-byte ratio was described as conservative but
 * under-counted such a transcript by about a fifth, so the budget guard did not
 * bound what it claimed to. Metrics still record this estimate beside Claude's
 * reported counters; recalibrate from that logged data before changing it.
 */
function estimateTransportTokens(transcriptBytes: number, catalogBytes: number, systemBytes: number, images: number): number {
  const textTokens = Math.ceil((transcriptBytes + catalogBytes + systemBytes) / 2.4);
  return Math.ceil(textTokens * 1.1) + images * 2_000;
}

/**
 * The response ceiling this transport gives Claude Code. Two rules, both Pi's own:
 * a requested cap budgets the answer and reasoning is added on top of it
 * (`adjustMaxTokensForThinking`), and the result is clamped to the room the
 * context window actually has left (`clampMaxTokensToContext`). Reserving the
 * model maximum instead used to reject requests whose prompt fit with tens of
 * thousands of tokens to spare, and squeezing reasoning inside a small
 * requested cap truncated the answer it was supposed to protect — a compaction
 * summary cut off mid-sentence is discarded whole, and Pi pays to make another.
 */
export function availableOutputTokens(
  model: Model<Api>,
  estimatedInputTokens: number,
  requested: number | undefined,
  effort: string,
): number {
  const modelMaximum = model.maxTokens ?? 0;
  if (!Number.isSafeInteger(modelMaximum) || modelMaximum <= 0) {
    throw new ClaudeCodeError("max_tokens", "Pi maxTokens must be a positive integer");
  }
  if (requested !== undefined && (!Number.isSafeInteger(requested) || requested <= 0)) {
    throw new ClaudeCodeError("max_tokens", "Pi maxTokens must be a positive integer");
  }
  const ceiling = requested === undefined
    ? modelMaximum
    : Math.min(requested + (THINKING_BUDGET_TOKENS[effort] ?? 0), modelMaximum);
  const contextWindow = model.contextWindow ?? 0;
  if (contextWindow <= 0) return ceiling;
  const safety = Math.min(CONTEXT_SAFETY_TOKENS, Math.floor(contextWindow / 10));
  const available = contextWindow - estimatedInputTokens - safety;
  if (available < Math.min(MIN_ANSWER_TOKENS, ceiling)) {
    throw new ClaudeCodeError(
      "context_budget",
      `context_length_exceeded: estimated Claude Code transport input ${estimatedInputTokens} leaves no room for a reply within context ${contextWindow}`,
    );
  }
  return Math.min(ceiling, available);
}

/** Control and evidence for the readiness wait; evidence is gathered only on failure. */
export interface ReadyWaitOptions {
  bridgeArgv?: readonly string[];
  /** Claude Code's stderr so far, read lazily so a healthy request pays nothing. */
  stderr?: () => string;
  /** Another signal that the wait is over, checked beside the ready marker. */
  settled?: () => boolean;
}

/** Internal test seam for the MCP readiness race. */
export async function waitForReadyOrExit(
  path: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  processResult: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  options: ReadyWaitOptions = {},
): Promise<void> {
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let processError: unknown;
  void processResult.then(
    (result) => { exited = result; },
    (error) => { processError = error; },
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new ClaudeCodeError("aborted", "Claude Code request was aborted");
    // An answer Claude already gave outranks anything this wait could synthesize.
    if (options.settled?.() === true) return;
    if (processError) throw processError;
    if (exited) {
      throw new ClaudeCodeError(
        "mcp_startup",
        `Claude Code exited before the Pi proposal MCP server became ready ` +
        `(code ${String(exited.code)}, signal ${String(exited.signal)})${readyDiagnosticSuffix(options)}`,
      );
    }
    if (await pathExists(path)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  // Name the resolved command: this timeout is far more often an unlaunchable
  // bridge than a slow one, and a bare duration sends people to the wrong knob.
  // Report seconds, not milliseconds: Pi classifies a failed turn by matching
  // HTTP status substrings in its text, and a millisecond figure such as
  // "5000ms" reads as a retryable 500 and restarts a request that needs a fix.
  throw new ClaudeCodeError(
    "mcp_startup",
    `Pi proposal MCP server did not become ready within ${formatSeconds(timeoutMs)}${readyDiagnosticSuffix(options)}`,
  );
}

/**
 * Claude Code reports a failed MCP server in its initialization record, but in
 * print mode that record can arrive only after the prompt is written, which this
 * wait precedes. Its stderr is therefore the sole first-hand evidence available
 * at timeout, so carry it rather than leaving the duration to speak alone.
 */
function readyDiagnosticSuffix(options: ReadyWaitOptions): string {
  const command = options.bridgeArgv
    ? `; Claude Code was told to launch argv: ${formatBridgeArgv(options.bridgeArgv)}`
    : "";
  const captured = options.stderr?.().trim() ?? "";
  const stderr = captured ? `; Claude Code stderr: ${captured.slice(-READY_STDERR_BYTES)}` : "";
  return `${command}${stderr}; run /pi-claude-code-provider-doctor to complete the handshake directly`;
}

/** Durations belong in seconds in user-facing text; see the readiness timeout above. */
function formatSeconds(milliseconds: number): string {
  return `${Number((milliseconds / 1000).toFixed(3))}s`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function containsPrivateTransportToolArgument(output: MutableOutput, directory: string): boolean {
  // Normalize the needle once: tool arguments can carry hundreds of kilobytes
  // of model-authored text, and this scan runs over every one of them.
  const normalizedDirectory = directory.normalize("NFC");
  return output.content.some(
    (block) => block.type === "toolCall" && containsPrivateTransportPath(block.arguments, normalizedDirectory),
  );
}

function containsPrivateTransportPath(value: unknown, directory: string): boolean {
  if (typeof value === "string") return value.normalize("NFC").includes(directory);
  if (Array.isArray(value)) return value.some((item) => containsPrivateTransportPath(item, directory));
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some((item) => containsPrivateTransportPath(item, directory));
}

async function applyPayloadHook(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<Context> {
  const logical: LogicalProviderPayload = {
    systemPrompt: context.systemPrompt,
    messages: context.messages,
    tools: context.tools,
  };
  // Pi supplies this callback even when no extension handler replaces the
  // payload. Validate the effective post-callback object here; serialization
  // remains a separate fail-closed defense for direct/internal callers.
  const replacement = await options?.onPayload?.(logical, model);
  return validateLogicalPayload(replacement === undefined ? logical : replacement);
}

function validateLogicalPayload(value: unknown): Context {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ClaudeCodeError("payload_invalid", "before_provider_request returned an invalid logical payload");
  }
  const payload = value as Partial<LogicalProviderPayload>;
  if (!Array.isArray(payload.messages)) {
    throw new ClaudeCodeError("payload_invalid", "Logical provider payload must contain a messages array");
  }
  if (payload.tools !== undefined && !Array.isArray(payload.tools)) {
    throw new ClaudeCodeError("payload_invalid", "Logical provider payload tools must be an array");
  }
  if (payload.systemPrompt !== undefined && typeof payload.systemPrompt !== "string") {
    throw new ClaudeCodeError("payload_invalid", "Logical provider systemPrompt must be a string");
  }
  for (const message of payload.messages as unknown[]) validateLogicalMessage(message);
  for (const tool of (payload.tools ?? []) as unknown[]) validateLogicalTool(tool);
  return { systemPrompt: payload.systemPrompt, messages: payload.messages, tools: payload.tools };
}

function validateLogicalMessage(value: unknown): void {
  const message = logicalObject(value, "message");
  if (message.role === "user") {
    if (typeof message.content === "string") return;
    validateContent(message.content, new Set(["text", "image"]), "user");
    return;
  }
  if (message.role === "assistant") {
    validateContent(message.content, new Set(["text", "thinking", "toolCall"]), "assistant");
    return;
  }
  if (message.role === "toolResult") {
    nonemptyString(message.toolCallId, "tool-result ID");
    nonemptyString(message.toolName, "tool-result name");
    if (typeof message.isError !== "boolean") invalidPayload("Tool-result isError must be boolean");
    validateContent(message.content, new Set(["text", "image"]), "toolResult");
    return;
  }
  invalidPayload(`Unsupported logical message role: ${String(message.role)}`);
}

function validateContent(value: unknown, allowed: ReadonlySet<string>, role: string): void {
  if (!Array.isArray(value)) invalidPayload(`Logical ${role} content must be an array`);
  for (const valueBlock of value) {
    const block = logicalObject(valueBlock, `${role} content block`);
    if (typeof block.type !== "string" || !allowed.has(block.type)) {
      invalidPayload(`Unsupported logical ${role} content block: ${String(block.type)}`);
    }
    if (block.type === "text") {
      if (typeof block.text !== "string") invalidPayload("Logical text content must contain text");
    } else if (block.type === "thinking") {
      if (typeof block.thinking !== "string") invalidPayload("Logical thinking content must contain thinking");
      if (block.redacted !== undefined && typeof block.redacted !== "boolean") invalidPayload("Logical thinking redacted must be boolean");
    } else if (block.type === "toolCall") {
      nonemptyString(block.id, "tool-call ID");
      nonemptyString(block.name, "tool-call name");
      serializableObject(block.arguments, "tool-call arguments");
    } else if (block.type === "image") {
      if (typeof block.data !== "string" || typeof block.mimeType !== "string") {
        invalidPayload("Logical image content must contain string data and mimeType");
      }
    }
  }
}

function validateLogicalTool(value: unknown): void {
  const tool = logicalObject(value, "tool");
  nonemptyString(tool.name, "tool name");
  if (typeof tool.description !== "string") invalidPayload("Logical tool description must be a string");
  serializableObject(tool.parameters, "tool schema");
}

function logicalObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidPayload(`Logical ${label} must be an object`);
  return value as Record<string, unknown>;
}

function nonemptyString(value: unknown, label: string): void {
  if (typeof value !== "string" || !value.trim()) invalidPayload(`Logical ${label} must be a nonempty string`);
}

function serializableObject(value: unknown, label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidPayload(`Logical ${label} must be an object`);
  try {
    if (typeof JSON.stringify(value) !== "string") invalidPayload(`Logical ${label} must be JSON-serializable`);
  } catch {
    invalidPayload(`Logical ${label} must be JSON-serializable`);
  }
}

function invalidPayload(message: string): never {
  throw new ClaudeCodeError("payload_invalid", message);
}
