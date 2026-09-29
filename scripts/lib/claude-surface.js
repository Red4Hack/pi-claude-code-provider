import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerArgs, thinkingDisplay } from "../../src/claude-args.ts";
import { validateClaudeInitialization } from "../../src/claude-protocol.ts";
import { captureEnvironment, captureTimeout, spawnCaptureChild, stopCaptureChild } from "./claude-capture.js";

export const SURFACE_CASES = [
  ...["sonnet", "opus"].flatMap((model) => ["low", "medium", "high", "xhigh", "max"].map((effort) => ({ model, effort }))),
  { model: "haiku", effort: undefined },
];

/** Store only startup records and the effort field; inference is refused locally. */
export async function captureSurfaceCase(executable, { model, effort }, timeoutMs = 60_000) {
  const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-surface-"));
  let body;
  let receiveBody;
  const received = new Promise((resolve) => { receiveBody = resolve; });
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method === "POST" && request.url.startsWith("/v1/messages") && !request.url.includes("count_tokens")) {
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = undefined; }
        receiveBody();
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "local capture complete" } }));
      } else response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  let process;
  let stdout = "";
  let captureError;
  try {
    const home = join(directory, "home");
    await mkdir(home);
    const systemPromptPath = join(directory, "system-prompt.txt");
    await writeFile(systemPromptPath, "Inert startup and effort capture.");
    const { args, prompt } = providerArgs({
      directory, systemPromptPath, attachmentPaths: [], transcriptBlocks: ['{"role":"user","content":"Reply OK."}'],
    }, model, effort, { thinkingDisplay: thinkingDisplay() });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    process = spawnCaptureChild(executable, args, {
      cwd: directory, env: captureEnvironment(home, `http://127.0.0.1:${server.address().port}`),
    });
    process.child.stdout.on("data", (chunk) => { stdout += chunk; });
    process.child.stderr.resume();
    process.child.stdin.end(`${JSON.stringify({ type: "user", message: { role: "user", content: prompt } })}\n`);
    try {
      await captureTimeout(Promise.race([received, process.closed]), `${model}:${effort ?? "default"} surface capture`, timeoutMs);
      await stopCaptureChild(process);
    } catch (error) {
      // Preserve startup evidence even if the CLI stalls before its API request.
      captureError = error.message;
      await stopCaptureChild(process, 100);
    }
    captureError ??= process.stdinError?.message;
    const records = stdout.split("\n").filter(Boolean).map((line) => {
      try { return JSON.parse(line); }
      catch {
        captureError ??= "Claude Code emitted invalid JSONL";
        return { type: "invalid_jsonl", text: line };
      }
    });
    const initialization = records.filter((record) => record.type === "system" && record.subtype === "init");
    const initIndex = records.indexOf(initialization[0]);
    return {
      model, requestedEffort: effort ?? null, observedEffort: body?.output_config?.effort ?? null,
      requestCaptured: Boolean(body), initializationCount: initialization.length,
      initialization: sanitizeSurface(initialization[0] ?? null, directory),
      preInitRecords: sanitizeSurface(initIndex === -1 ? records : records.slice(0, initIndex), directory),
      ...(captureError ? { captureError: sanitizeSurface(captureError, directory) } : {}),
    };
  } finally {
    try {
      if (process) await stopCaptureChild(process, 100);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}

export function surfaceErrors(entry) {
  const errors = [];
  if (entry.captureError) errors.push(entry.captureError);
  if (!entry.requestCaptured) errors.push("Claude Code sent no inference request to loopback");
  if (entry.initializationCount !== 1) errors.push(`expected one initialization, observed ${entry.initializationCount}`);
  if (entry.preInitRecords.length) {
    errors.push(`pre-init records: ${entry.preInitRecords.map((record) => `${record.type}/${record.subtype ?? ""}`).join(", ")}`);
  }
  try { validateClaudeInitialization(entry.initialization, { tools: new Set(), mcpServer: "none" }); }
  catch (error) { errors.push(error.message); }
  if (entry.observedEffort !== entry.requestedEffort) {
    errors.push(`effort mismatch: requested ${entry.requestedEffort}, observed ${entry.observedEffort}`);
  }
  return errors;
}

function sanitizeSurface(value, privateRoot) {
  if (Array.isArray(value)) return value.map((entry) => sanitizeSurface(entry, privateRoot));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key,
      ["cwd", "messaging_socket_path"].includes(key) ? "/capture" :
      ["session_id", "uuid", "timestamp"].includes(key) ? "<capture>" : sanitizeSurface(nested, privateRoot),
    ]));
  }
  if (typeof value !== "string") return value;
  return value.split(privateRoot).join("/capture").replace(/(?:\/tmp|\/home|\/Users|\/var\/folders)\/[^\s"']*/g, "/capture")
    .replace(/[A-Z]:\\[^\s"']*/gi, "<capture-path>")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<capture-email>");
}
