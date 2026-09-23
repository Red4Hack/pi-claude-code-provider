// Capture what Claude Code's stream-json emits when an API attempt fails, without
// spending subscription quota. A loopback ANTHROPIC_BASE_URL and a dummy token make the
// CLI talk to a local server that scripts each attempt's response; nothing reaches
// Anthropic and no account credential is read.
//
// The argument vector, stdin prompt and child environment come from the provider's own
// providerArgs and buildClaudeEnvironment, so the records are what a real request would
// produce. The provider's handling of these shapes is tested against the captures rather
// than against hand-written sequences, because hand-written ones encode what we believe
// Claude Code does instead of what it does: the external fix this replaced asserted event
// orders Claude Code was never observed to emit.
//
// Records are sanitized on the way out (session ids, uuids, timestamps, paths) and
// written to test/support/captured/, where test/support/claude-fixture.js loads them.
//
// Each file is named for the Claude Code version that produced it, taken from its own
// init record, so a capture on a newer CLI never overwrites the pinned set. Re-pin
// CAPTURED_STREAM_RECOVERY_VERSION in test/support/claude-fixture.js deliberately, after
// reading the diff, and delete the version the tests no longer load. That diff is the
// point of committing the artifacts.
//
//   npm run capture:claude-stream-recovery                 # every scenario
//   npm run capture:claude-stream-recovery -- drop sse-error
//   npm run capture:claude-stream-recovery -- --claude /path/to/claude --print drop
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeExecutable, buildClaudeEnvironment } from "../src/auth.ts";
import { providerArgs } from "../src/claude-args.ts";

const CAPTURED = fileURLToPath(new URL("../test/support/captured/", import.meta.url));
// A CLI that neither answers nor exits would otherwise hang the capture.
const RUN_TIMEOUT_MS = 90_000;
const EXIT_TIMEOUT_MS = 5000;
// Long enough for Claude Code to have parsed what arrived before the socket dies.
const CUT_DELAY_MS = 200;

const USAGE = { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 };
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const messageStart = (id, model) =>
  frame("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: USAGE } });
const textStart = (index, text) =>
  frame("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }) +
  frame("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } });
const blockStop = (index) => frame("content_block_stop", { type: "content_block_stop", index });
const toolStart = (index, id, json) =>
  frame("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id, name: "mcp__pi__probe", input: {} } }) +
  frame("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json } });
const sseError = frame("error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
const messageEnd = (reason) =>
  frame("message_delta", { type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 2 } }) +
  frame("message_stop", { type: "message_stop" });

const OVERLOADED = '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
const complete = (text) => messageStart("msg_done", "claude-sonnet-5") + textStart(0, text) + blockStop(0) + messageEnd("end_turn");

/**
 * Each scenario answers one attempt at a time. `attempt` counts from 1, `stream` is
 * false once Claude Code falls back to a non-streaming request, and the reply either
 * ends the response or cuts the socket mid-stream.
 */
const SCENARIOS = {
  // A retryable HTTP status before any stream bytes: an ordinary pre-stream retry.
  http529: ({ attempt }) => (attempt === 1 ? { status: 529, body: OVERLOADED } : { sse: complete("answer after a pre-stream retry") }),
  // The socket dies mid-text. Claude Code has not yielded the block, so it retries.
  drop: ({ attempt }) =>
    attempt === 1 ? { sse: messageStart("msg_1", "claude-sonnet-5") + textStart(0, "abandoned partial"), cut: true } : { sse: complete("surviving answer") },
  // The socket dies after a completed text block, so Claude Code continues instead.
  "drop-text-stop": ({ attempt }) =>
    attempt === 1
      ? { sse: messageStart("msg_1", "claude-sonnet-5") + textStart(0, "complete first block") + blockStop(0), cut: true }
      : { sse: complete("continued second half") },
  // The socket dies after a completed tool_use block.
  "drop-tool": ({ attempt }) =>
    attempt === 1
      ? { sse: messageStart("msg_1", "claude-sonnet-5") + toolStart(0, "toolu_abandoned", '{"path":"abandoned"}') + blockStop(0), cut: true }
      : { sse: complete("answer after the abandoned tool call") },
  // The socket dies inside streamed tool arguments, truncating their JSON.
  "drop-partial-tool": ({ attempt }) =>
    attempt === 1 ? { sse: messageStart("msg_1", "claude-sonnet-5") + toolStart(0, "toolu_partial", '{"path":"abandon'), cut: true } : { sse: complete("surviving answer") },
  // A mid-stream SSE error, which Claude Code answers with a non-streaming request.
  "sse-error": ({ attempt, stream }) =>
    attempt === 1
      ? { sse: messageStart("msg_1", "claude-sonnet-5") + textStart(0, "abandoned partial") + sseError }
      : stream
        ? { sse: complete("surviving answer") }
        : { json: { id: "msg_2", type: "message", role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "non-streaming replacement" }], stop_reason: "end_turn", stop_sequence: null, usage: USAGE } },
  // The response completes, then the socket dies before the connection closes.
  "post-stop": ({ attempt }) => (attempt === 1 ? { sse: complete("complete first"), cut: true } : { sse: complete("surviving answer") }),
  // The response reaches the output limit, which Claude Code answers with a synthetic
  // continuation turn of its own.
  "max-tokens": ({ attempt, model }) => ({
    sse: messageStart(`msg_${attempt}`, model) + textStart(0, attempt === 1 ? "truncated by limit" : "continued") + blockStop(0) + messageEnd(attempt === 1 ? "max_tokens" : "end_turn"),
  }),
  // A normal tool proposal, including the permission_denied and tool_result records
  // Claude Code emits before the stop reason in every handoff.
  "tool-ok": ({ attempt, model }) =>
    attempt === 1
      ? { sse: messageStart(`msg_${attempt}`, model) + textStart(0, "calling") + blockStop(0) + toolStart(1, "toolu_ok", '{"path":"probe"}') + blockStop(1) + messageEnd("tool_use") }
      : { sse: messageStart(`msg_${attempt}`, model) + textStart(0, "after denial") + blockStop(0) + messageEnd("end_turn") },
};

const FIXED = {
  session_id: "00000000-0000-4000-8000-000000000000",
  timestamp: "2026-01-01T00:00:00.000Z",
  cwd: "/project",
  messaging_socket_path: "/socket",
  time_to_request_ms: 0,
  duration_ms: 0,
  duration_api_ms: 0,
  total_cost_usd: 0,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Replace machine- and run-specific values, so a re-capture diffs only where Claude Code changed. */
function sanitize(value, uuids) {
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, uuids));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, key in FIXED ? FIXED[key] : sanitize(nested, uuids)]));
  }
  if (typeof value !== "string") return value;
  if (UUID.test(value)) {
    if (!uuids.has(value)) uuids.set(value, `00000000-0000-4000-8000-${String(uuids.size + 1).padStart(12, "0")}`);
    return uuids.get(value);
  }
  return value.replace(/(?:\/tmp|\/home|\/Users|\/var\/folders)\/[^\s"']*/g, "/redacted");
}

function scriptedServer(scenario) {
  let attempt = 0;
  return createServer((request, response) => {
    let data = "";
    request.on("data", (chunk) => (data += chunk));
    request.on("end", () => {
      if (!request.url.startsWith("/v1/messages") || request.url.includes("count_tokens")) {
        return response.writeHead(200, { "content-type": "application/json" }).end("{}");
      }
      let body;
      try {
        body = JSON.parse(data);
      } catch {
        return response.writeHead(400).end("{}");
      }
      const reply = SCENARIOS[scenario]({ attempt: ++attempt, stream: body.stream === true, model: body.model });
      if (reply.status) return response.writeHead(reply.status, { "content-type": "application/json" }).end(reply.body);
      if (reply.json) return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply.json));
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (!reply.cut) return response.end(reply.sse);
      response.write(reply.sse);
      setTimeout(() => response.socket.destroy(), CUT_DELAY_MS);
    });
  });
}

/** Resolve once the child has exited, or after a bounded wait if it will not. */
function closed(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      child.once("exit", done);
    }, EXIT_TIMEOUT_MS);
    child.once("exit", done);
  });
}

async function captureScenario(scenario, executable) {
  const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-recovery-"));
  const home = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-recovery-home-"));
  const server = scriptedServer(scenario);
  try {
    await writeFile(join(directory, "system-prompt.txt"), "Inert capture prompt.");
    await writeFile(
      join(directory, "tools.json"),
      JSON.stringify([{ name: "probe", description: "Inert", inputSchema: { type: "object", properties: { path: { type: "string" } } } }]),
    );
    const prepared = {
      directory,
      systemPromptPath: join(directory, "system-prompt.txt"),
      attachmentPaths: [],
      transcriptBlocks: ['{"role":"user","content":"Reply OK."}'],
      catalogPath: join(directory, "tools.json"),
      readyPath: join(directory, "mcp-ready"),
      violationPath: join(directory, "mcp-execution-attempt"),
    };
    const { args, prompt } = providerArgs(prepared, "sonnet", "low");
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    // The loopback base URL and dummy token are exactly what
    // buildClaudeEnvironment refuses to forward. This capture overrides them
    // after that call, where the override is visible, rather than through it.
    const env = {
      ...buildClaudeEnvironment({ HOME: home }),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      CLAUDE_CODE_OAUTH_TOKEN: "local-capture-dummy-oauth-token",
    };
    // An inherited proxy would send this capture off the loopback interface, and a
    // relocated configuration directory would expose the account it must never read.
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "CLAUDE_CONFIG_DIR"]) delete env[name];
    const child = spawn(executable, args, { cwd: directory, env, stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stdin.end(`${JSON.stringify({ type: "user", message: { role: "user", content: prompt } })}\n`);
    let timer;
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${scenario}: Claude Code did not finish within ${RUN_TIMEOUT_MS}ms`)), RUN_TIMEOUT_MS);
      }),
    ]).finally(() => {
      clearTimeout(timer);
      child.kill();
    });
    await closed(child);
    const uuids = new Map();
    const records = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => sanitize(JSON.parse(line), uuids));
    if (records.length === 0) throw new Error(`${scenario}: Claude Code produced no records`);
    const version = records.find((record) => record.subtype === "init")?.claude_code_version;
    if (typeof version !== "string") throw new Error(`${scenario}: Claude Code did not report its version in init`);
    return { records, version };
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
}

const argv = process.argv.slice(2);
let executable;
let print = false;
const requested = [];
for (let index = 0; index < argv.length; index++) {
  if (argv[index] === "--claude") executable = argv[++index];
  else if (argv[index] === "--print") print = true;
  else requested.push(argv[index]);
}
const scenarios = requested.length > 0 ? requested : Object.keys(SCENARIOS);
const unknown = scenarios.filter((scenario) => !(scenario in SCENARIOS));
if (unknown.length > 0) {
  console.error(`Unknown scenario(s): ${unknown.join(", ")}`);
  console.error(`Known: ${Object.keys(SCENARIOS).join(", ")}`);
  process.exit(1);
}
executable ??= claudeExecutable();
for (const scenario of scenarios) {
  const { records, version } = await captureScenario(scenario, executable);
  const body = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  const target = join(CAPTURED, `claude-${version}-stream-${scenario}.jsonl`);
  if (print) console.log(body);
  else await writeFile(target, body);
  const shapes = records.map((record) => (record.type === "stream_event" ? record.event.type : `${record.type}${record.subtype ? `/${record.subtype}` : ""}`));
  console.log(`${scenario.padEnd(20)} ${version}  ${String(records.length).padStart(3)} records  ${shapes.join(" ")}`);
}
