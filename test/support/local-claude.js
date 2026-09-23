import { spawn } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPTURED_CLAUDE_HELP_PATH, CAPTURED_CLAUDE_VERSION, ELIGIBLE_CLAUDE_AUTH_JSON } from "./claude-fixture.js";
import { nodeFixtureSource } from "./node-fixture.js";

/**
 * A Claude Code stand-in that speaks the real headless surface this provider
 * depends on, backed by a local llama.cpp server instead of a subscription.
 *
 * It exists so the transport can be exercised end to end — preflight, the MCP
 * proposal handshake, the ordered JSONL protocol, tool handoff, and process
 * cleanup — without spending Claude quota. It is a test double, never a
 * compatibility oracle: passing here says this provider's own contract holds,
 * and says nothing about what Claude Code actually emits. Only the paid gate in
 * DEVELOPING.md can say that.
 */

// llama.cpp's own default. A server on another host is selected per run with
// PI_CLAUDE_LOCAL_BASE_URL or --base-url; this package publishes no network layout.
export const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:8080";
export const DEFAULT_LOCAL_MODEL = "openbmb/MiniCPM5-2B-GGUF:Q4_K_M";
const MODULE_PATH = fileURLToPath(import.meta.url);
/** Claude Code closes a correlated handoff, for a tool call or an output limit, as 143 on POSIX; so must this. */
const HANDOFF_EXIT = 143;
const HANDOFF_FALLBACK_MS = 30_000;

/**
 * Write an executable Claude Code stand-in whose configuration is baked in.
 * The provider filters the environment it hands Claude, so configuration
 * cannot arrive through environment variables; a generated launcher is the
 * same mechanism the deterministic fixtures already use.
 */
export async function createLocalClaudeExecutable(directory, options = {}) {
  const config = {
    baseUrl: options.baseUrl ?? DEFAULT_LOCAL_BASE_URL,
    model: options.model ?? DEFAULT_LOCAL_MODEL,
    version: options.version ?? CAPTURED_CLAUDE_VERSION,
    // A local model answers in one piece, so this covers model load, prompt
    // processing, and generation together. Slow hardware is not a failure.
    requestTimeoutMs: options.requestTimeoutMs ?? 60 * 60_000,
    temperature: options.temperature ?? 0,
  };
  const executable = join(directory, process.platform === "win32" ? "claude.cjs" : "claude");
  await writeFile(
    executable,
    nodeFixtureSource(`
const config = ${JSON.stringify(config)};
import(${JSON.stringify(MODULE_PATH)})
  .then((module) => module.runLocalClaude(process.argv.slice(2), config))
  .catch((error) => {
    process.stderr.write(\`local-claude failed: \${error?.stack ?? String(error)}\\n\`);
    process.exit(2);
  });
`),
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  return executable;
}

export async function runLocalClaude(argv, config) {
  if (argv.includes("--version")) return write(`${config.version} (Claude Code)\n`);
  if (argv[0] === "auth" && argv[1] === "status") return write(ELIGIBLE_CLAUDE_AUTH_JSON);
  if (argv.includes("--help")) return write(await readFile(CAPTURED_CLAUDE_HELP_PATH, "utf8"));
  await runHeadlessTurn(argv, config);
}

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function runHeadlessTurn(argv, config) {
  const systemPromptFile = optionValue(argv, "--system-prompt-file");
  const systemPrompt = systemPromptFile ? await readFile(systemPromptFile, "utf8") : "";
  const maxTokens = Number(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS) || 1024;
  // Install the close handler before anything the provider could react to. It
  // terminates a handoff, for a tool call or an output limit, the moment it sees
  // the stop reason, and a signal that arrives before this is registered kills
  // the process by default action — reported as a signal death rather than the
  // 143 a handoff closes with.
  const handoff = installCloseHandler();
  const proposals = await connectProposalServer(optionValue(argv, "--mcp-config"));
  handoff.own(proposals);
  const prompt = await readPrompt();

  // Claude Code emits nothing before the prompt arrives, and the provider's
  // readiness gate depends on that ordering, so initialization is announced here.
  emit({
    type: "system",
    subtype: "init",
    tools: proposals.tools.map((tool) => `mcp__pi__${tool.name}`),
    mcp_servers: proposals.connected ? [{ name: "pi", status: "connected" }] : [],
    model: config.model,
    permissionMode: "dontAsk",
    slash_commands: [],
    skills: [],
    plugins: [],
    apiKeySource: "none",
  });

  const completion = await complete(config, { systemPrompt, prompt, maxTokens, tools: proposals.tools });
  const usage = {
    input_tokens: completion.usage.prompt_tokens ?? 0,
    output_tokens: completion.usage.completion_tokens ?? 0,
    cache_read_input_tokens: completion.usage.prompt_tokens_details?.cached_tokens ?? 0,
    cache_creation_input_tokens: 0,
  };
  emit({ type: "stream_event", event: { type: "message_start", message: { id: `msg_local_${Date.now()}`, model: config.model, usage: {} } } });

  const toolCall = completion.toolCalls[0];
  const stopReason = toolCall ? "tool_use" : completion.truncated ? "max_tokens" : "end_turn";
  // The provider terminates Claude Code the moment it reads either handoff stop:
  // a tool call, or an output limit that Claude Code would otherwise answer with
  // a continuation turn of its own. Both close as a handoff, armed before either
  // stop reason can be read.
  const handsOff = stopReason !== "end_turn";
  if (handsOff) handoff.expectHandoffClose();
  let index = 0;
  if (completion.reasoning) index = emitBlock(index, { type: "thinking", thinking: "" }, "thinking_delta", "thinking", completion.reasoning);
  if (toolCall) {
    emit({ type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "tool_use", id: toolCall.id, name: `mcp__pi__${toolCall.name}` } } });
    for (const chunk of split(toolCall.argumentsJson)) {
      emit({ type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: chunk } } });
    }
    emit({ type: "stream_event", event: { type: "content_block_stop", index } });
  } else {
    index = emitBlock(index, { type: "text", text: "" }, "text_delta", "text", completion.text);
  }

  emit({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: stopReason }, usage } });
  emit({ type: "stream_event", event: { type: "message_stop" } });

  const modelUsage = { [config.model]: { contextWindow: 32_768, maxOutputTokens: maxTokens } };
  if (handsOff) {
    // The provider terminates a handoff as soon as it sees the stop reason, so
    // this mirrors the acknowledgement Claude Code emits and then waits to be
    // closed. Finishing on its own instead races that termination: a signal
    // that lands while the process is exiting is reported as a signal death.
    emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      stop_reason: stopReason,
      terminal_reason: "aborted_streaming",
      usage,
      modelUsage,
    });
    handoff.awaitClose();
    return;
  }
  emit({ type: "result", is_error: false, result: completion.text, stop_reason: stopReason, usage, modelUsage });
  proposals.close();
}

function emitBlock(index, block, deltaType, deltaField, text) {
  emit({ type: "stream_event", event: { type: "content_block_start", index, content_block: block } });
  for (const chunk of split(text)) {
    emit({ type: "stream_event", event: { type: "content_block_delta", index, delta: { type: deltaType, [deltaField]: chunk } } });
  }
  emit({ type: "stream_event", event: { type: "content_block_stop", index } });
  return index + 1;
}

/** Stream in pieces: a single delta would never exercise the provider's accumulation. */
function split(text, size = 64) {
  const chunks = [];
  for (let offset = 0; offset < text.length; offset += size) chunks.push(text.slice(offset, offset + size));
  return chunks.length > 0 ? chunks : [""];
}

/**
 * Close the way Claude Code does. A correlated handoff, for a tool call or an
 * output limit, closes as 143; any other termination — a cancelled turn, say —
 * is an ordinary close. The exit code therefore follows what this turn actually
 * acknowledged, and the handler is installed before the provider has anything
 * to react to.
 */
function installCloseHandler() {
  let handoffExpected = false;
  let proposals = { close() {} };
  const close = () => {
    proposals.close();
    process.exit(handoffExpected ? HANDOFF_EXIT : 0);
  };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
  return {
    own(current) {
      proposals = current;
    },
    expectHandoffClose() {
      handoffExpected = true;
    },
    /** Stay alive to be closed, bounded so a provider that never closed cannot leak this process. */
    awaitClose() {
      setTimeout(close, HANDOFF_FALLBACK_MS);
    },
  };
}

async function readPrompt() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const line = Buffer.concat(chunks).toString("utf8").split("\n").filter(Boolean).at(-1);
  if (!line) return "";
  const record = JSON.parse(line);
  const content = record?.message?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? content.filter((block) => block?.type === "text").map((block) => block.text).join("\n")
    : "";
}

/**
 * Complete the initialize and tools/list handshake against the proposal bridge.
 * This is what writes the readiness marker the provider waits for, so a
 * stand-in that skipped it would leave that gate untested.
 */
async function connectProposalServer(mcpConfig) {
  const empty = { tools: [], connected: false, close() {} };
  if (!mcpConfig) return empty;
  const server = JSON.parse(mcpConfig).mcpServers?.pi;
  if (!server) return empty;
  const child = spawn(server.command, server.args ?? [], {
    env: { ...process.env, ...server.env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const responses = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) {
        try {
          const message = JSON.parse(line);
          if (message.id !== undefined) responses.get(message.id)?.(message);
        } catch {
          // A malformed bridge line is the bridge's failure to report, not this one's.
        }
      }
      newline = buffer.indexOf("\n");
    }
  });
  const request = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out`)), 15_000);
    responses.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  await request(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "local-claude", version: "1.0.0" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const listed = await request(2, "tools/list", {});
  return {
    tools: listed.result?.tools ?? [],
    connected: true,
    close() {
      child.stdin.end();
      child.kill("SIGTERM");
    },
  };
}

/** Ask the local llama.cpp server for this turn's content. */
async function complete(config, { systemPrompt, prompt, maxTokens, tools }) {
  const body = {
    model: config.model,
    messages: [
      ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
      { role: "user", content: prompt },
    ],
    max_tokens: maxTokens,
    temperature: config.temperature,
  };
  if (tools.length > 0) {
    body.tools = tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description ?? "", parameters: tool.inputSchema ?? { type: "object" } },
    }));
  }
  const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(`local model returned ${response.status}: ${(await response.text()).slice(0, 400)}`);
  }
  const payload = await response.json();
  const choice = payload.choices?.[0] ?? {};
  const message = choice.message ?? {};
  return {
    text: typeof message.content === "string" ? message.content : "",
    reasoning: typeof message.reasoning_content === "string" ? message.reasoning_content.trim() : "",
    truncated: choice.finish_reason === "length",
    toolCalls: (message.tool_calls ?? []).map((call, position) => ({
      id: call.id || `toolu_local_${position}`,
      name: call.function?.name ?? "",
      argumentsJson: normalizeArguments(call.function?.arguments),
    })).filter((call) => call.name),
    usage: payload.usage ?? {},
  };
}

/** Tool arguments must reach the provider as a JSON object, whatever the server sent. */
function normalizeArguments(value) {
  if (value && typeof value === "object") return JSON.stringify(value);
  try {
    const parsed = JSON.parse(typeof value === "string" && value.trim() ? value : "{}");
    return JSON.stringify(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {});
  } catch {
    return "{}";
  }
}

function emit(record) {
  write(`${JSON.stringify(record)}\n`);
}

function write(text) {
  process.stdout.write(text);
}
