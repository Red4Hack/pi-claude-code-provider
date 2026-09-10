import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildClaudeEnvironment, claudeExecutable, claudeLaunch } from "../src/auth.ts";
import { providerArgs } from "../src/claude-args.ts";
import { prepareRequest } from "../src/context-serializer.ts";
import { removeRuntimeDirectory } from "../src/runtime-directories.ts";

/**
 * Capture the JSONL protocol real Claude Code emits for a provider request,
 * driving it against a custom model endpoint so the capture costs no
 * subscription quota. Claude Code accepts an alternate base URL, API-key auth,
 * and per-alias model overrides; a local llama.cpp server answering
 * `/v1/messages` is enough to exercise the CLI's own protocol end to end.
 *
 * The argument vector comes from `providerArgs`, not from a copy of it: a
 * capture taken with different arguments would describe a request this package
 * never makes. The provider itself refuses this configuration — it requires
 * subscription authentication and `apiKeySource: "none"` — so this is a capture
 * tool, never a way to run the provider on another model.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_TARGET = join(root, "test", "support", "captured");

function optionValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const baseUrl = optionValue("--base-url", process.env.PI_CLAUDE_LOCAL_BASE_URL ?? "http://127.0.0.1:8080");
const localModel = optionValue("--model", process.env.PI_CLAUDE_LOCAL_MODEL ?? "openbmb/MiniCPM5-2B-GGUF:Q4_K_M");
const prompt = optionValue("--prompt", "Reply with exactly: CAPTURED-OK");
const effort = optionValue("--effort", "low");
const maxOutputTokens = optionValue("--max-output-tokens", "512");
const timeoutMs = Number(optionValue("--timeout-ms", process.env.PI_CLAUDE_LOCAL_TIMEOUT_MS ?? 60 * 60_000));
const target = optionValue("--out", undefined);

/**
 * Redact what identifies this machine or this run. Everything else is kept
 * verbatim: the point of a captured artifact is that it is what the CLI emitted.
 */
function sanitize(line) {
  const replacements = [
    [homedir(), "<HOME>"],
    [tmpdir(), "<TMP>"],
    [`/run/user/${process.getuid?.() ?? ""}`, "<RUNTIME>"],
  ].filter(([value]) => value.length > 1);
  let safe = line;
  for (const [value, replacement] of replacements) safe = safe.split(value).join(replacement);
  return safe
    .replace(/"(session_id|uuid)":"[^"]*"/g, '"$1":"<ID>"')
    .replace(/"messaging_socket_path":"[^"]*"/g, '"messaging_socket_path":"<SOCKET>"');
}

const context = {
  systemPrompt: "You are a helpful assistant. Answer exactly as asked.",
  messages: [{ role: "user", content: prompt, timestamp: 1 }],
  tools: [{ name: "read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }],
};

const prepared = await prepareRequest(context);
let captured = "";
let stderr = "";
let version = "unknown";
try {
  const { args, prompt: promptBlocks } = providerArgs(prepared, "sonnet", effort);
  const executable = claudeExecutable();
  const launch = claudeLaunch(executable, args);
  const child = spawn(launch.command, launch.args, {
    cwd: prepared.directory,
    env: buildClaudeEnvironment({
      ...launch.env,
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: maxOutputTokens,
      ...(prepared.catalogPath ? { PI_CLAUDE_TOOL_CATALOG: prepared.catalogPath } : {}),
      // Claude Code's own overrides: an alternate endpoint, API-key auth, and a
      // model for each alias this provider selects.
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "local-capture",
      ANTHROPIC_DEFAULT_SONNET_MODEL: localModel,
      ANTHROPIC_DEFAULT_OPUS_MODEL: localModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: localModel,
      ANTHROPIC_DEFAULT_FABLE_MODEL: localModel,
      ANTHROPIC_SMALL_FAST_MODEL: localModel,
    }),
    detached: process.platform !== "win32",
    windowsHide: process.platform === "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { captured += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const timer = setTimeout(() => {
    try { process.kill(-(child.pid ?? 0), "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }, timeoutMs);
  child.stdin.end(`${JSON.stringify({ type: "user", message: { role: "user", content: promptBlocks } })}\n`);
  const { code, signal } = await new Promise((resolve) => {
    child.once("close", (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
  });
  clearTimeout(timer);
  if (!captured.trim()) {
    throw new Error(`Claude Code produced no protocol output (code ${String(code)}, signal ${String(signal)}): ${stderr.trim()}`);
  }
  version = JSON.parse(captured.split("\n").find(Boolean)).claude_code_version ?? "unknown";
} finally {
  await removeRuntimeDirectory(prepared.directory);
}

const path = target ?? join(DEFAULT_TARGET, `claude-${version}-protocol.jsonl`);
await mkdir(dirname(path), { recursive: true });
await writeFile(path, `${captured.split("\n").filter(Boolean).map(sanitize).join("\n")}\n`);
const records = captured.split("\n").filter(Boolean).length;
console.log(`Captured ${records} records from Claude Code ${version} on ${localModel} to ${path}`);
console.log("Review the diff before re-pinning: this artifact is what the CLI emitted, not what this package expects.");
