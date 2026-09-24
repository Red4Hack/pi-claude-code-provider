import { parseStreamingJson } from "@earendil-works/pi-ai";
import type { AssistantMessageEventStream, ToolCall } from "@earendil-works/pi-ai";
import { TRANSCRIPT_BREAKPOINT_ENV } from "./claude-args.ts";
import { ClaudeCodeError } from "./errors.ts";
import {
  isCacheBreakpointLimit,
  parseRateLimitNotice,
  rateLimitRejectionMessage,
  requireRecord,
  terminalResultErrorDetail,
  validateClaudeInitialization,
  type RateLimitNoticeSink,
} from "./claude-protocol.ts";
import type { MutableOutput } from "./types.ts";

interface StreamEventEnvelope {
  type?: string;
  subtype?: string;
  event?: Record<string, unknown>;
  result?: string | null;
  errors?: unknown;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, Record<string, unknown>>;
  is_error?: boolean;
  api_error_status?: number | null;
  stop_reason?: string | null;
  terminal_reason?: string | null;
  tools?: unknown;
  mcp_servers?: unknown;
  mcp_server_errors?: unknown;
  model?: string;
  permissionMode?: string;
  slash_commands?: unknown;
  skills?: unknown;
  plugins?: unknown;
  apiKeySource?: string;
  rate_limit_info?: unknown;
}

/** Publishes Pi's provider-response observation once the transport handshake validates. Async observers gate body mapping. */
export type ResponseAnnouncementSink = () => void | Promise<void>;

export interface ClaudeEventMapperOptions {
  stream: AssistantMessageEventStream;
  output: MutableOutput;
  expectedTools: Set<string>;
  toolNames: Map<string, string>;
  onToolUse: () => void;
  /** Omitted only by tests: without it a max_tokens stop falls back to failing on Claude Code's continuation. */
  onLengthStop?: () => void;
  onRateLimitNotice?: RateLimitNoticeSink;
  onResponseAnnouncement?: ResponseAnnouncementSink;
  privatePaths?: readonly string[];
}

interface IndexedBlock {
  // The map key is Claude's source index; contentIndex identifies the matching
  // position in output.content so mixed responses update the correct Pi block.
  contentIndex: number;
  partialJson?: string;
  /** Length of partialJson when its preview was last parsed. */
  parsedLength?: number;
}

export type ClaudeTerminationCause = "none" | "tool_handoff" | "caller_abort";

export class ClaudeEventMapper {
  private readonly blocks = new Map<number, IndexedBlock>();
  private initialized = false;
  private responseStarted = false;
  private responseAnnouncement: Promise<void> | undefined;
  private messageStarted = false;
  private streamMessageId: string | undefined;
  private messageStopped = false;
  private handoffLatched = false;
  private terminal = false;
  private resultReceived = false;
  private successfulResult: "stop" | "length" | undefined;
  private stopReason: string | undefined;
  private rejectedRateLimit: string | undefined;
  private deferredToolArguments: string | undefined;
  private breakpointLimitRejected = false;
  private servedContextWindow: number | undefined;
  private servedMaxOutputTokens: number | undefined;
  private readonly stream: AssistantMessageEventStream;
  private readonly output: MutableOutput;
  private readonly expectedTools: Set<string>;
  private readonly toolNames: Map<string, string>;
  private readonly onToolUse: () => void;
  private readonly onLengthStop: () => void;
  private readonly onRateLimitNotice: RateLimitNoticeSink;
  private readonly onResponseAnnouncement: ResponseAnnouncementSink;
  private assistantDiagnostic: string | undefined;
  private readonly privatePaths: readonly string[];

  constructor(options: ClaudeEventMapperOptions) {
    this.stream = options.stream;
    this.output = options.output;
    this.expectedTools = options.expectedTools;
    this.toolNames = options.toolNames;
    this.onToolUse = options.onToolUse;
    this.onLengthStop = options.onLengthStop ?? (() => {});
    this.onRateLimitNotice = options.onRateLimitNotice ?? (() => {});
    this.onResponseAnnouncement = options.onResponseAnnouncement ?? (() => {});
    this.privatePaths = options.privatePaths ?? [];
  }

  get isTerminal(): boolean {
    return this.terminal;
  }

  get hasSuccessfulResult(): boolean {
    return this.successfulResult !== undefined;
  }

  get contextWindow(): number | undefined {
    return this.servedContextWindow;
  }

  get maxOutputTokens(): number | undefined {
    return this.servedMaxOutputTokens;
  }

  get rateLimitFailure(): string | undefined {
    return this.rejectedRateLimit;
  }

  /** A held tool-argument failure, for the provider to report when no recovery signal claimed it. */
  get deferredFailure(): string | undefined {
    return this.deferredToolArguments;
  }

  private throwDeferredFailure(): void {
    const message = this.deferredToolArguments;
    if (!message) return;
    this.deferredToolArguments = undefined;
    throw new ClaudeCodeError("tool_arguments", message);
  }

  /** Whether the API rejected the request for carrying too many cache breakpoints. */
  get cacheBreakpointLimit(): boolean {
    return this.breakpointLimitRejected;
  }

  /** Wait for an asynchronous response observer before mapping Claude's response body. */
  async settleResponseAnnouncement(): Promise<void> {
    const announcement = this.responseAnnouncement;
    if (!announcement) return;
    await announcement;
    // Cleared only once it resolves, so the rest of the response stops re-awaiting
    // a settled promise on every record while a rejection still reaches each caller.
    this.responseAnnouncement = undefined;
    this.startResponse();
  }

  accept(value: unknown, terminationCause: ClaudeTerminationCause = "none"): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ClaudeCodeError("protocol_shape", "Invalid Claude event record");
    }
    const record = value as StreamEventEnvelope;
    if (record.type === "system" && record.subtype === "init") {
      this.validateInit(record);
      return;
    }
    if (!this.initialized) throw new ClaudeCodeError("protocol_order", "Claude emitted a record before initialization");
    if (!this.responseStarted) {
      throw new ClaudeCodeError("protocol_order", "Claude emitted a response record before Pi response observers completed");
    }
    if (this.resultReceived) throw new ClaudeCodeError("protocol_order", "Claude emitted a record after its result");
    if (record.type === "stream_event") {
      // Once a handoff is latched the provider is terminating Claude, but records
      // already in the pipe still arrive. Claude Code answers a tool denial or an output
      // limit with another message of its own, so these events belong to a turn Pi never
      // asked for: they must neither be published nor rejected as protocol drift.
      if (this.handoffLatched) return;
      if (!record.event || typeof record.event !== "object") {
        throw new ClaudeCodeError("protocol_shape", "Claude stream_event did not contain an event");
      }
      this.acceptStreamEvent(record.event);
    } else if (record.type === "result") {
      this.acceptResult(record, terminationCause);
    } else if (record.type === "rate_limit_event") {
      this.acceptRateLimit(record.rate_limit_info);
    } else if (record.type === "assistant") {
      this.rejectInterruptedStream(record);
      this.acceptAssistant(record);
    } else if (record.type === "user" || record.type === "system") {
      this.rejectInterruptedStream(record);
      // Completed user echoes and non-init system status records are redundant
      // because include-partial-messages supplies the canonical stream events.
    } else {
      throw new ClaudeCodeError("protocol_record", `Unsupported Claude record type: ${String(record.type)}`);
    }
  }

  fail(message: string, aborted = false): void {
    if (this.terminal) return;
    this.terminal = true;
    this.output.stopReason = aborted ? "aborted" : "error";
    this.output.errorMessage = message;
    this.stream.push({ type: "error", reason: this.output.stopReason, error: this.output });
    this.stream.end();
  }

  private validateInit(record: StreamEventEnvelope): void {
    if (this.initialized) throw new ClaudeCodeError("protocol_init", "Claude emitted duplicate initialization");
    this.output.responseModel = validateClaudeInitialization(record, {
      tools: this.expectedTools,
      mcpServer: this.expectedTools.size === 0 ? "none" : "pi",
      privatePaths: this.privatePaths,
    });
    this.initialized = true;
    // Validated initialization is this transport's analogue of a received
    // response: capabilities are known and no content has been published yet.
    // Announcing here, before the start event, lets Pi's
    // after_provider_response observers run ahead of any assistant content.
    const announcement = this.onResponseAnnouncement();
    if (isPromise(announcement)) this.responseAnnouncement = Promise.resolve(announcement);
    else this.startResponse();
  }

  private startResponse(): void {
    if (this.responseStarted || this.terminal) return;
    this.responseStarted = true;
    this.stream.push({ type: "start", partial: this.output });
  }

  /**
   * Claude Code recovers from an API failure that arrives after this response began
   * streaming by replaying the request, by continuing from the partial it kept, or by
   * re-requesting without streaming. Pi has already received the blocks streamed so far
   * and its events are append-only, so none of those recoveries can be published here:
   * rewriting content breaks Pi's contract, and content produced after the interruption
   * follows internal prompts Pi never saw. The provider instead reports one failure
   * whose wording Pi's own retry policy accepts, and Pi re-runs the turn from the
   * unchanged context in a fresh process. The replayed transcript is a prompt-cache hit,
   * so only the output tokens are produced twice.
   */
  private rejectInterruptedStream(record: StreamEventEnvelope): void {
    // Before the response starts, a retry is an ordinary pre-stream retry that costs
    // nothing to let through. After a tool-use stop the provider is already terminating
    // Claude for handoff, and records about Claude's own next request must not
    // invalidate a complete proposal. A max_tokens stop is followed by Claude Code's own
    // continuation, which the length handoff owns.
    if (!this.messageStarted || this.stopReason === "tool_use" || isLengthStop(this.stopReason)) return;
    const raw = record as Record<string, unknown>;
    let cause: string | undefined;
    if (record.type === "system" && record.subtype === "api_retry") {
      const category = typeof raw.error === "string" && raw.error.length > 0 ? raw.error : "unknown";
      const status = typeof raw.error_status === "number" && Number.isFinite(raw.error_status) ? `, HTTP ${raw.error_status}` : "";
      // A recorded rate-limit rejection already carries the reset time; it is both more
      // useful than the category alone and retryable.
      if (category === "rate_limit" && this.rejectedRateLimit) throw new ClaudeCodeError("stream_interrupted", this.rejectedRateLimit);
      if (!RETRYABLE_INTERRUPTIONS.has(category)) {
        throw new ClaudeCodeError("stream_interrupted", `Claude Code API request failed mid-response (${category}${status})`);
      }
      cause = `Claude Code began retrying: ${category}${status}`;
    } else if (record.type === "assistant") {
      if (typeof raw.error === "string" || raw.is_api_error_message === true) {
        cause = "Claude Code reported a mid-response API error";
      } else {
        const message = raw.message && typeof raw.message === "object" && !Array.isArray(raw.message)
          ? raw.message as Record<string, unknown>
          : undefined;
        // A different message id before this stream stops is Claude Code's non-streaming
        // replacement. Mid-stream echoes of the open message carry its own id, and the
        // completed echo of a finished message arrives only after message_stop.
        if (!this.messageStopped && typeof message?.id === "string" && message.id !== this.streamMessageId) {
          cause = "Claude Code replaced the stream with a non-streaming request";
        }
      }
    } else if (record.type === "user" && raw.isSynthetic === true) {
      // Claude Code's synthetic user turns ("Resume directly ...") each start another
      // internal model turn. Tool results in a normal handoff are not synthetic.
      cause = "Claude Code asked the model to continue a cut-off response";
    }
    // The fixed "stream ended before message_stop" phrasing is what Pi's retry
    // classifier matches; the cause alone is not enough.
    if (cause) throw new ClaudeCodeError("stream_interrupted", `Claude Code API stream ended before message_stop (${cause})`);
  }

  private acceptStreamEvent(event: Record<string, unknown>): void {
    const type = event.type;
    if (type === "message_start") {
      if (this.messageStarted) throw new ClaudeCodeError("protocol_message", "Claude emitted duplicate message_start");
      const message = requireRecord(event.message, "message_start.message");
      if (typeof message.model === "string") this.output.responseModel = message.model;
      if (typeof message.id === "string") this.output.responseId = message.id;
      this.streamMessageId = typeof message.id === "string" ? message.id : undefined;
      this.applyUsage(message.usage);
      this.messageStarted = true;
      return;
    }
    if (this.messageStopped) throw new ClaudeCodeError("protocol_order", `${String(type)} arrived after message_stop`);
    if (type === "ping") return;
    if (!this.messageStarted) throw new ClaudeCodeError("protocol_order", `${String(type)} arrived before message_start`);
    if (type === "content_block_start") this.startBlock(event);
    else if (type === "content_block_delta") this.deltaBlock(event);
    else if (type === "content_block_stop") this.endBlock(event);
    else if (type === "message_delta") this.acceptMessageDelta(event);
    else if (type === "message_stop") {
      if (this.blocks.size > 0) throw new ClaudeCodeError("protocol_blocks", "Claude stopped with unclosed content blocks");
      this.messageStopped = true;
      if (this.stopReason === "tool_use") this.latchHandoff(this.onToolUse);
      else if (isLengthStop(this.stopReason)) this.latchHandoff(this.onLengthStop);
    } else throw new ClaudeCodeError("protocol_event", `Unsupported Claude stream event: ${String(type)}`);
  }

  private acceptMessageDelta(event: Record<string, unknown>): void {
    const delta = requireRecord(event.delta, "message_delta.delta");
    if (delta.stop_reason !== null && delta.stop_reason !== undefined) {
      this.stopReason = stopReason(delta.stop_reason);
    }
    this.applyUsage(event.usage);
    if (this.stopReason === "tool_use") this.latchHandoff(this.onToolUse);
    else if (isLengthStop(this.stopReason)) this.latchHandoff(this.onLengthStop);
  }

  /** Stop mapping this response's stream and ask the provider to terminate Claude. */
  private latchHandoff(notify: () => void): void {
    this.handoffLatched = true;
    notify();
  }

  private startBlock(event: Record<string, unknown>): void {
    const sourceIndex = index(event.index);
    if (this.blocks.has(sourceIndex)) throw new ClaudeCodeError("protocol_blocks", `Duplicate content block index ${sourceIndex}`);
    const source = requireRecord(event.content_block, "content_block_start.content_block");
    const contentIndex = this.output.content.length;
    this.blocks.set(sourceIndex, { contentIndex, partialJson: "", parsedLength: 0 });
    if (source.type === "text") {
      this.output.content.push({ type: "text", text: typeof source.text === "string" ? source.text : "" });
      this.stream.push({ type: "text_start", contentIndex, partial: this.output });
    } else if (source.type === "thinking") {
      this.output.content.push({
        type: "thinking",
        thinking: typeof source.thinking === "string" ? source.thinking : "",
        thinkingSignature: typeof source.signature === "string" ? source.signature : undefined,
      });
      this.stream.push({ type: "thinking_start", contentIndex, partial: this.output });
    } else if (source.type === "redacted_thinking") {
      if (typeof source.data !== "string" || source.data.length === 0) {
        this.blocks.delete(sourceIndex);
        throw new ClaudeCodeError("protocol_block", "Claude emitted redacted thinking without opaque data");
      }
      this.output.content.push({
        type: "thinking",
        thinking: "",
        thinkingSignature: source.data,
        redacted: true,
      });
      this.stream.push({ type: "thinking_start", contentIndex, partial: this.output });
    } else if (source.type === "tool_use") {
      const qualifiedName = typeof source.name === "string" ? source.name : "";
      const name = this.toolNames.get(qualifiedName);
      if (!name) throw new ClaudeCodeError("tool_unknown", `Claude proposed an unknown tool: ${qualifiedName}`);
      if (typeof source.id !== "string" || source.id.length === 0) throw new ClaudeCodeError("tool_id", "Claude emitted a tool without an ID");
      const initial = source.input && typeof source.input === "object" && !Array.isArray(source.input)
        ? source.input as ToolCall["arguments"]
        : {};
      this.output.content.push({ type: "toolCall", id: source.id, name, arguments: initial });
      this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
    } else {
      this.blocks.delete(sourceIndex);
      throw new ClaudeCodeError("protocol_block", `Unsupported Claude content block: ${String(source.type)}`);
    }
  }

  private deltaBlock(event: Record<string, unknown>): void {
    const sourceIndex = index(event.index);
    const indexed = this.blocks.get(sourceIndex);
    if (!indexed) throw new ClaudeCodeError("protocol_blocks", `Delta for unknown content block ${sourceIndex}`);
    const delta = requireRecord(event.delta, "content_block_delta.delta");
    const block = this.output.content[indexed.contentIndex];
    if (delta.type === "text_delta" && block?.type === "text" && typeof delta.text === "string") {
      block.text += delta.text;
      this.stream.push({ type: "text_delta", contentIndex: indexed.contentIndex, delta: delta.text, partial: this.output });
    } else if (delta.type === "thinking_delta" && block?.type === "thinking" && typeof delta.thinking === "string") {
      block.thinking += delta.thinking;
      this.stream.push({ type: "thinking_delta", contentIndex: indexed.contentIndex, delta: delta.thinking, partial: this.output });
    } else if (delta.type === "signature_delta" && block?.type === "thinking" && typeof delta.signature === "string") {
      block.thinkingSignature = `${block.thinkingSignature ?? ""}${delta.signature}`;
    } else if (delta.type === "input_json_delta" && block?.type === "toolCall" && typeof delta.partial_json === "string") {
      const partialJson = `${indexed.partialJson ?? ""}${delta.partial_json}`;
      indexed.partialJson = partialJson;
      if (argumentPreviewDue(partialJson.length, indexed.parsedLength ?? 0)) {
        indexed.parsedLength = partialJson.length;
        // A preview only; content_block_stop parses the complete arguments strictly.
        const preview = parseStreamingJson<unknown>(partialJson);
        if (preview && typeof preview === "object" && !Array.isArray(preview)) {
          block.arguments = preview as ToolCall["arguments"];
        }
      }
      this.stream.push({ type: "toolcall_delta", contentIndex: indexed.contentIndex, delta: delta.partial_json, partial: this.output });
    } else {
      throw new ClaudeCodeError("protocol_delta", `Delta ${String(delta.type)} did not match its content block`);
    }
  }

  private endBlock(event: Record<string, unknown>): void {
    const sourceIndex = index(event.index);
    const indexed = this.blocks.get(sourceIndex);
    if (!indexed) throw new ClaudeCodeError("protocol_blocks", `Stop for unknown content block ${sourceIndex}`);
    const block = this.output.content[indexed.contentIndex];
    if (block?.type === "text") {
      this.stream.push({ type: "text_end", contentIndex: indexed.contentIndex, content: block.text, partial: this.output });
    } else if (block?.type === "thinking") {
      this.stream.push({ type: "thinking_end", contentIndex: indexed.contentIndex, content: block.thinking, partial: this.output });
    } else if (block?.type === "toolCall") {
      if (indexed.partialJson) {
        try {
          const parsed = JSON.parse(indexed.partialJson) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
          block.arguments = parsed as ToolCall["arguments"];
        } catch {
          // A connection drop inside streamed tool arguments truncates the JSON. Claude
          // Code then closes the block, stops the message and announces its recovery, so
          // hold this failure: if a recovery signal follows, the retryable interruption
          // is the accurate explanation. Nothing publishes the block either way.
          this.deferredToolArguments = `Claude emitted invalid arguments for tool ${block.name}`;
          this.blocks.delete(sourceIndex);
          return;
        }
      }
      this.stream.push({ type: "toolcall_end", contentIndex: indexed.contentIndex, toolCall: block as ToolCall, partial: this.output });
    } else throw new ClaudeCodeError("protocol_blocks", `Missing output block for source index ${sourceIndex}`);
    this.blocks.delete(sourceIndex);
  }

  private acceptResult(record: StreamEventEnvelope, terminationCause: ClaudeTerminationCause): void {
    if (this.terminal) return;
    // Stream envelopes are untrusted JSON despite the TypeScript interface.
    // Validate terminal fields before they can cross into Pi's typed output.
    if (typeof record.is_error !== "boolean") {
      throw new ClaudeCodeError("protocol_result", "Claude result omitted a boolean is_error field");
    }
    if (record.result !== undefined && record.result !== null && typeof record.result !== "string") {
      throw new ClaudeCodeError("protocol_result", "Claude result contained a non-string result field");
    }
    this.resultReceived = true;
    this.applyUsage(record.usage);
    this.applyModelUsage(record.modelUsage);
    if (record.is_error) {
      if (this.isExpectedHandoffTermination(record, terminationCause)) return;
      this.throwDeferredFailure();
      const status = typeof record.api_error_status === "number" && Number.isFinite(record.api_error_status)
        ? ` (${record.api_error_status})`
        : "";
      let detail = terminalResultErrorDetail(record as Record<string, unknown>, this.assistantDiagnostic, this.rejectedRateLimit);
      if (isCacheBreakpointLimit(detail)) {
        this.breakpointLimitRejected = true;
        detail += `; Claude Code placed more prompt-cache breakpoints than the API allows. Restart Pi with ` +
          `${TRANSCRIPT_BREAKPOINT_ENV}=off to drop this provider's transcript breakpoint (prompt caching is lost ` +
          `while it is off) and report your Claude Code version`;
      }
      this.fail(`Claude Code request failed${status}: ${detail}`);
      return;
    }
    this.throwDeferredFailure();
    // Only a successful result must account for every block it opened. An error result
    // is reported as itself: the API failure is the useful message, and checking the
    // block shape first hid it behind a protocol complaint.
    if (this.blocks.size > 0) throw new ClaudeCodeError("protocol_blocks", "Claude result arrived with unclosed content blocks");
    if (record.stop_reason !== null && record.stop_reason !== undefined && this.stopReason === undefined) {
      this.stopReason = stopReason(record.stop_reason);
    }
    // Claude result envelopes make success explicit. Do not infer it from an
    // absent flag or subtype string, which could hide protocol drift.
    if (this.stopReason === "tool_use") throw new ClaudeCodeError("protocol_result", "Claude returned success after a tool-use stop");
    if (this.output.content.length === 0 && record.result) this.pushFallbackText(record.result);
    this.successfulResult = isLengthStop(this.stopReason) ? "length" : "stop";
    this.output.stopReason = this.successfulResult;
  }

  /** Publish a validated result only after the provider has settled and cleaned its process state. */
  completeResult(): boolean {
    if (this.terminal) return false;
    if (!this.successfulResult) throw new ClaudeCodeError("protocol_result", "Claude result was not ready for completion");
    this.terminal = true;
    this.stream.push({ type: "done", reason: this.successfulResult, message: this.output });
    this.stream.end();
    return true;
  }

  completeToolUse(): boolean {
    if (this.terminal) return false;
    this.throwDeferredFailure();
    if (this.blocks.size > 0) throw new ClaudeCodeError("protocol_blocks", "Tool use completed with unclosed content blocks");
    if (!this.output.content.some((block) => block.type === "toolCall")) {
      throw new ClaudeCodeError("protocol_tool", "Claude reported tool use without a tool call");
    }
    this.terminal = true;
    this.output.stopReason = "toolUse";
    this.stream.push({ type: "done", reason: "toolUse", message: this.output });
    this.stream.end();
    return true;
  }

  /**
   * Publish a response that reached the output limit or the context window, after the
   * provider has terminated Claude. Claude Code answers either stop with a synthetic
   * "Output token limit hit" turn and another message, so the provider stops it at the
   * stop reason and returns Pi the ordinary `length` stop the response earned.
   */
  completeLength(): boolean {
    if (this.terminal) return false;
    this.throwDeferredFailure();
    if (this.blocks.size > 0) throw new ClaudeCodeError("protocol_blocks", "Output limit stop completed with unclosed content blocks");
    if (!isLengthStop(this.stopReason)) throw new ClaudeCodeError("protocol_stop", "Claude did not report an output limit stop");
    this.terminal = true;
    this.output.stopReason = "length";
    this.stream.push({ type: "done", reason: "length", message: this.output });
    this.stream.end();
    return true;
  }

  /** Whether an error result is only the provider's own handoff termination, for a tool call or an output limit. */
  private isExpectedHandoffTermination(record: StreamEventEnvelope, terminationCause: ClaudeTerminationCause): boolean {
    if (terminationCause !== "tool_handoff") return false;
    if (record.subtype !== "error_during_execution" || record.is_error !== true) return false;
    if (record.api_error_status !== undefined || record.result !== undefined) return false;
    if (record.terminal_reason !== "aborted_streaming") return false;
    if (isLengthStop(this.stopReason)) return record.stop_reason === this.stopReason;
    return this.stopReason === "tool_use" &&
      record.stop_reason === "tool_use" &&
      this.output.content.some((block) => block.type === "toolCall");
  }

  private pushFallbackText(text: string): void {
    const contentIndex = this.output.content.length;
    this.output.content.push({ type: "text", text });
    this.stream.push({ type: "text_start", contentIndex, partial: this.output });
    this.stream.push({ type: "text_delta", contentIndex, delta: text, partial: this.output });
    this.stream.push({ type: "text_end", contentIndex, content: text, partial: this.output });
  }

  private acceptAssistant(record: StreamEventEnvelope): void {
    if (this.assistantDiagnostic !== undefined) return;
    const raw = record as Record<string, unknown>;
    const error = typeof raw.error === "string" ? raw.error.trim() : "";
    const message = raw.message && typeof raw.message === "object" && !Array.isArray(raw.message)
      ? raw.message as Record<string, unknown>
      : undefined;
    const content = message?.content;
    const text = typeof content === "string"
      ? content.trim()
      : Array.isArray(content)
        ? content
          .filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === "object" && !Array.isArray(block))
          .filter((block) => block.type === "text" && typeof block.text === "string")
          .map((block) => (block.text as string).trim())
          .filter(Boolean)
          .join(" ")
        : "";
    const diagnostic = [error, text].filter(Boolean).join(": ");
    if (diagnostic) this.assistantDiagnostic = diagnostic;
  }

  private acceptRateLimit(info: unknown): void {
    const notice = parseRateLimitNotice(info);
    if (!notice) return;
    // Repeats are de-duplicated once per session by the extension's notifier,
    // which serves web search too.
    try {
      this.onRateLimitNotice(notice);
    } catch {
      // UI notifications are advisory and must never fail a provider request.
    }
    if (notice.status === "rejected") this.rejectedRateLimit = rateLimitRejectionMessage(notice);
  }

  private applyModelUsage(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const entries = Object.values(value as Record<string, unknown>);
    for (const raw of entries) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const usage = raw as Record<string, unknown>;
      this.servedContextWindow ??= number(usage.contextWindow);
      this.servedMaxOutputTokens ??= number(usage.maxOutputTokens);
    }
  }

  private applyUsage(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const usage = value as Record<string, unknown>;
    const input = number(usage.input_tokens);
    const output = number(usage.output_tokens);
    const cacheRead = number(usage.cache_read_input_tokens);
    const cacheWrite = number(usage.cache_creation_input_tokens);
    if (input !== undefined) this.output.usage.input = input;
    if (output !== undefined) this.output.usage.output = output;
    if (cacheRead !== undefined) this.output.usage.cacheRead = cacheRead;
    if (cacheWrite !== undefined) this.output.usage.cacheWrite = cacheWrite;
    const outputDetails = usage.output_tokens_details as Record<string, unknown> | undefined;
    const reasoning = number(outputDetails?.thinking_tokens);
    if (reasoning !== undefined) this.output.usage.reasoning = reasoning;
    const cacheCreation = usage.cache_creation as Record<string, unknown> | undefined;
    const cacheWrite1h = number(cacheCreation?.ephemeral_1h_input_tokens);
    if (cacheWrite1h !== undefined) this.output.usage.cacheWrite1h = cacheWrite1h;
    this.output.usage.totalTokens =
      this.output.usage.input + this.output.usage.output + this.output.usage.cacheRead + this.output.usage.cacheWrite;
  }
}

// api_retry categories that describe a transient transport or server failure. Every
// other documented category (billing_error, authentication_failed, invalid_request, ...)
// describes a condition that repeating the turn cannot clear.
const RETRYABLE_INTERRUPTIONS = new Set(["overloaded", "server_error", "unknown"]);

/**
 * Whether a stop ends the response at a limit Pi reports as `length`. The API
 * accepts input plus max_tokens beyond the window and stops generation at the
 * window with `model_context_window_exceeded`. Claude Code answers that stop
 * exactly as it answers `max_tokens`, with a synthetic continuation turn, so it
 * takes the same handoff; Pi then compacts and retries a short length stop.
 */
function isLengthStop(reason: string | undefined): boolean {
  return reason === "max_tokens" || reason === "model_context_window_exceeded";
}

function stopReason(value: unknown): string {
  // Claude exposes this as a string rather than a closed enum. Pi only gives
  // special meaning to max_tokens and tool_use, so preserve future values as
  // ordinary stops instead of rejecting an otherwise valid response.
  if (typeof value !== "string" || value.length === 0) {
    throw new ClaudeCodeError("protocol_stop", `Invalid Claude stop reason: ${String(value)}`);
  }
  return value;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function index(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ClaudeCodeError("protocol_index", `Invalid Claude content index: ${String(value)}`);
  }
  return value;
}

function isPromise(value: unknown): value is PromiseLike<void> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

/**
 * Whether streamed tool arguments are due for another preview parse. Each parse
 * rescans the whole string, so parsing on every delta costs time quadratic in
 * the argument size. Waiting until the string has grown by a quarter since the
 * last parse keeps the total work a constant multiple of the final size; the
 * floor keeps small arguments previewing promptly. Exported for tests.
 */
export function argumentPreviewDue(receivedLength: number, parsedLength: number): boolean {
  return receivedLength - parsedLength >= Math.max(64, parsedLength / 4);
}
