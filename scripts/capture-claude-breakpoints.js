// Capture where Claude Code places prompt-cache breakpoints in the request this
// provider actually sends, without spending subscription quota. A loopback
// ANTHROPIC_BASE_URL and a dummy token make the CLI serialize a request; the
// local server records it and answers 400. Nothing reaches Anthropic and no
// account credential is read.
//
// The argument vector, stdin prompt and child environment come from the
// provider's own providerArgs and buildClaudeEnvironment, so this follows the
// provider instead of drifting from a hand-rebuilt copy of it.
//
// Two captures are taken with different private request directories but the
// same session image store. That separates a missing transcript breakpoint
// from a changing prefix caused by request paths or attachment references.
// A single capture cannot tell them apart.
//
// Like the provider, Claude runs in a project directory rather than the private
// one: a disposable git repository shared by both captures. It carries a Git
// clean filter and a same-size edit to the filtered file, so a Claude Code
// release that starts running git status at startup again executes the filter.
// The verdict is BROKEN if that filter runs, a project file changes, Claude Code
// reports no working directory or any other than the project, the private request
// directory reaches the model outside attachment narration, or the proposal
// bridge never becomes ready.
//
//   npm run capture:claude-breakpoints
//   npm run capture:claude-breakpoints -- --model haiku
//   npm run capture:claude-breakpoints -- --model opus --effort high
//   npm run capture:claude-breakpoints -- --strip-marker
//   npm run capture:claude-breakpoints -- --images 2 --output /tmp/body.json
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { claudeExecutable, buildClaudeEnvironment } from "../src/auth.ts";
import { providerArgs } from "../src/claude-args.ts";
import { SessionImageStore } from "../src/session-image-store.ts";

// Anthropic permits four cache breakpoints per request. A fifth is rejected
// outright, so this is a hard ceiling rather than a quality signal.
const MAX_BREAKPOINTS = 4;
// A CLI that neither sends a request nor exits would otherwise hang the capture.
const CAPTURE_TIMEOUT_MS = 60_000;
// Transcript-dominant padding, well past every model's minimum cacheable prefix,
// so a cached system prompt cannot stand in for a reusable history.
const PAD = Array.from({ length: 2600 }, (_, index) => `stable-${index % 97}`).join(" ");
const BLOCKS = [
  JSON.stringify({ protocol: "capture", instruction: "Inert cache-shape probe." }),
  JSON.stringify({ role: "user", content: `Inert padding: ${PAD}` }),
  JSON.stringify({ role: "user", content: "Reply exactly OK." }),
  JSON.stringify({ role: "assistant", content: [{ type: "text", text: "OK" }] }),
  JSON.stringify({ role: "user", content: "Reply exactly APPEND-OK." }),
];
const SYSTEM_PROMPT = "You are an inert cache-shape probe. Answer the current request.";
const CATALOG = [{ name: "probe", description: "Inert proposal only", inputSchema: { type: "object", properties: {} } }];
// A 1x1 PNG, enough for the CLI to treat an @-reference as a real attachment.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function parseOptions(argv) {
  const options = { model: "sonnet", effort: "low", images: 0, tools: true, marker: true, claude: undefined, output: undefined };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${flag} requires a value`);
      return next;
    };
    if (flag === "--model") options.model = value();
    else if (flag === "--effort") options.effort = value();
    else if (flag === "--images") options.images = Number.parseInt(value(), 10);
    else if (flag === "--claude") options.claude = value();
    else if (flag === "--output") options.output = value();
    else if (flag === "--no-tools") options.tools = false;
    // The control arm: drop the breakpoint the provider sets, to show the
    // regressed shape on an affected build without editing src/claude-args.ts.
    else if (flag === "--strip-marker") options.marker = false;
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (!Number.isInteger(options.images) || options.images < 0) throw new Error("--images requires a non-negative integer");
  return options;
}

/** Serve exactly one request body on loopback, then refuse so the CLI stops. */
function captureServer() {
  let resolveBody;
  const body = new Promise((resolve) => {
    resolveBody = resolve;
  });
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      // The CLI may probe other endpoints first. Only a POST carrying a body is
      // the inference request; anything else is refused without being recorded.
      const received = Buffer.concat(chunks).toString("utf8");
      if (request.method === "POST" && received) resolveBody(received);
      const payload = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "local capture complete" } });
      response.writeHead(400, { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) });
      response.end(payload);
    });
  });
  const listening = new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, body, listening, port: () => server.address().port };
}

/**
 * A git project whose clean filter appends to a marker outside the working tree.
 * The tracked file is edited without changing its size, so git status has to run
 * the filter to decide whether the content changed.
 */
async function createProjectFixture(markerRoot) {
  const project = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-capture-project-"));
  const marker = join(markerRoot, "clean-filter-ran");
  const git = (...args) => execFileSync("git", ["-C", project, "-c", "core.hooksPath=/dev/null", ...args], { stdio: "ignore" });
  try {
    git("init", "-q");
    await writeFile(join(project, "tracked.txt"), "before\n");
    await writeFile(join(project, ".gitattributes"), "tracked.txt filter=probe\n");
    git("add", "tracked.txt", ".gitattributes");
    git("-c", "user.name=capture", "-c", "user.email=capture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture");
  } catch (error) {
    await rm(project, { recursive: true, force: true });
    throw new Error(`git is required for the startup side-effect fixture: ${error.message}`);
  }
  // A POSIX shell script; on Windows the filter probe is skipped and reported as such.
  const filterProbe = process.platform !== "win32";
  if (filterProbe) {
    const filter = join(markerRoot, "clean-filter.sh");
    await writeFile(filter, `#!/bin/sh\ncat\nprintf 'clean filter ran\\n' >> '${marker}'\n`, { mode: 0o700 });
    git("config", "filter.probe.clean", filter);
  }
  await writeFile(join(project, "tracked.txt"), "after!\n");
  return { project, marker, filterProbe };
}

/** Content hashes of every working-tree file outside .git. */
async function snapshotTree(root) {
  const files = new Map();
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.set(relative(root, path), createHash("sha256").update(await readFile(path)).digest("hex"));
    }
  };
  await walk(root);
  return files;
}

async function captureOnce(options, executable, home, project, imageStore) {
  const { server, body, listening, port } = captureServer();
  await listening;
  const baseUrl = `http://127.0.0.1:${port()}`;
  // Mirror the provider: a fresh private request directory holds the system
  // prompt and catalog, while generated images use session-stable paths.
  const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-request-"));
  const imageLease = imageStore.acquire();
  try {
    await writeFile(join(directory, "system-prompt.txt"), SYSTEM_PROMPT);
    await writeFile(join(directory, "tools.json"), JSON.stringify(CATALOG));
    const attachmentPaths = [];
    for (let index = 0; index < options.images; index++) {
      const name = `image-${createHash("sha256").update(PNG).digest("hex")}.png`;
      const path = await imageLease.put(name, PNG);
      attachmentPaths.push(path);
    }
    const prepared = {
      directory,
      systemPromptPath: join(directory, "system-prompt.txt"),
      attachmentPaths,
      transcriptBlocks: BLOCKS,
      ...(options.tools
        ? {
            catalogPath: join(directory, "tools.json"),
            readyPath: join(directory, "mcp-ready"),
            violationPath: join(directory, "mcp-execution-attempt"),
          }
        : {}),
    };
    const { args, prompt } = providerArgs(prepared, options.model, options.effort, { transcriptBreakpoint: options.marker });
    const env = buildClaudeEnvironment({
      HOME: home,
      ANTHROPIC_BASE_URL: baseUrl,
      CLAUDE_CODE_OAUTH_TOKEN: "local-capture-dummy-oauth-token",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000",
    });
    // An inherited proxy would send this capture off the loopback interface.
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) delete env[name];
    // A relocated configuration directory would expose the account this capture must never read.
    delete env.CLAUDE_CONFIG_DIR;
    const child = spawn(executable, args, { cwd: project, env, stdio: ["pipe", "ignore", "ignore"] });
    child.stdin.end(`${JSON.stringify({ type: "user", message: { role: "user", content: prompt } })}\n`);
    let timer;
    const captured = await Promise.race([
      body,
      new Promise((_, reject) => child.once("exit", () => setTimeout(() => reject(new Error("Claude Code sent no request to the local capture server")), 1000))),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Claude Code sent no request within ${CAPTURE_TIMEOUT_MS}ms`)), CAPTURE_TIMEOUT_MS);
      }),
    ]).finally(() => {
      clearTimeout(timer);
      child.kill();
    });
    // Claude Code sends its first request only after the MCP tool catalog loads.
    const bridgeReady = options.tools ? existsSync(prepared.readyPath) : undefined;
    return { body: redact(JSON.parse(captured)), prompt, directory, bridgeReady };
  } finally {
    server.close();
    imageLease.release();
    await rm(directory, { recursive: true, force: true });
  }
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, redact(nested)]));
  if (typeof value === "string") return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<redacted-email>");
  return value;
}

/** Flatten every block into [label, block] in the order the API reads them. */
function flatten(body) {
  const blocks = [];
  (body.system ?? []).forEach((entry, index) => blocks.push([`system[${index}]`, entry]));
  (body.messages ?? []).forEach((message, messageIndex) => {
    if (typeof message.content === "string") {
      blocks.push([`messages[${messageIndex}]`, { type: "text", text: message.content }]);
      return;
    }
    (message.content ?? []).forEach((block, blockIndex) => blocks.push([`messages[${messageIndex}].content[${blockIndex}]`, block]));
  });
  return blocks;
}

function report(captures, options, startup) {
  const { body, prompt } = captures.at(-1);
  const blocks = flatten(body);
  const sent = new Set(prompt.map((block) => block.text));
  const history = blocks.flatMap(([, block], position) => (sent.has(block.text) ? [position] : []));
  const first = history.at(0) ?? -1;
  const last = history.at(-1) ?? -1;
  const region = (position) => (position < first ? "ahead of it" : position <= last ? "transcript" : "appended after");

  console.log(`served model:   ${body.model}`);
  console.log(`message roles:  ${(body.messages ?? []).map((message) => message.role).join(", ")}`);
  const marked = blocks.flatMap(([label, block], position) => (block.cache_control ? [{ position, label, block }] : []));
  // The last breakpoint inside the transcript marks the prefix a later request
  // reuses. Only a change at or ahead of it invalidates that entry; the
  // attachment list after it varies only when the effective image set changes.
  const transcriptBreakpoint = marked.filter(({ position }) => position >= first && position <= last).at(-1)?.position ?? -1;
  console.log(`breakpoints:    ${marked.length} of ${MAX_BREAKPOINTS} permitted`);
  for (const { position, label, block } of marked) {
    const ttl = block.cache_control.ttl ?? "5m (default)";
    const preview = JSON.stringify((block.text ?? "").slice(0, 44).replaceAll("\n", " "));
    console.log(`  ${label.padEnd(28)} ttl=${ttl.padEnd(12)} ${region(position).padEnd(16)} ${preview}`);
  }

  const earlier = flatten(captures[0].body);
  // Compare whole blocks: an image or tool block can change without a text field.
  const varying = blocks.findIndex(([, block], position) => JSON.stringify(earlier[position]?.[1]) !== JSON.stringify(block));
  if (varying === -1) {
    console.log("first varying:  nothing; the two captures are byte-identical");
  } else {
    console.log(`first varying:  ${blocks[varying][0]} (${region(varying)})`);
    const shown = (block) => (block === undefined ? "" : typeof block.text === "string" ? block.text : JSON.stringify(block));
    const [left, right] = [earlier[varying]?.[1], blocks[varying][1]].map((block) => shown(block).split("\n"));
    for (const [index, line] of right.entries()) {
      if (left[index] !== line) console.log(`  - ${left[index] ?? ""}\n  + ${line}`);
    }
  }

  const environment = blocks.map(([, block]) => block.text ?? "").find((text) => text.includes("Primary working directory:"));
  const reportedCwd = environment?.match(/Primary working directory: (.*)/)?.[1]?.trim();
  console.log(`project cwd:    ${startup.project}`);
  console.log(`environment:    ${reportedCwd === undefined ? "no working directory reported" : `Primary working directory ${reportedCwd}`}`);
  // With attachments, Claude Code narrates each read by its private path; that is expected.
  const privateLeak = captures.some(({ body: captured, directory }) =>
    options.images > 0 ? (environment ?? "").includes(directory) : JSON.stringify(captured).includes(directory));
  const bridgeNotReady = options.tools && captures.some(({ bridgeReady }) => !bridgeReady);
  console.log(
    `startup:        ${startup.filterProbe ? `git clean filter ${startup.filterRan ? "RAN" : "did not run"}` : "git clean filter probe skipped on Windows"}; ` +
      `${startup.changedFiles.length ? `project files changed: ${startup.changedFiles.join(", ")}` : "project files unchanged"}` +
      `${options.tools ? `; bridge ${bridgeNotReady ? "NOT ready" : "ready"}` : ""}`,
  );

  // Startup side effects come first: they are wrong regardless of caching. The
  // breakpoint verdicts follow in the order that makes the earliest the actionable answer.
  const verdict = startup.filterRan
    ? "BROKEN: starting Claude in the project ran its Git clean filter, a side effect before any Pi tool call"
    : startup.changedFiles.length
      ? "BROKEN: starting Claude changed project files"
      : reportedCwd !== startup.project
        ? reportedCwd === undefined
          ? "BROKEN: Claude Code reported no working directory, so its environment block has changed shape"
          : "BROKEN: Claude Code reports a working directory other than the project, contradicting Pi's"
        : privateLeak
          ? "BROKEN: the private request directory reaches the model outside attachment narration"
          : bridgeNotReady
            ? "BROKEN: the proposal bridge was not ready when Claude Code sent its request"
            : marked.length > MAX_BREAKPOINTS
              ? `BROKEN: ${marked.length} breakpoints exceeds the ${MAX_BREAKPOINTS} the API accepts; it will reject this request`
              : transcriptBreakpoint === -1
                ? "BROKEN: no breakpoint inside the transcript, so no growing prefix is reusable"
                : varying !== -1 && varying <= transcriptBreakpoint
                  ? `BROKEN: ${blocks[varying][0]} (${region(varying)}) changes every request, at or ahead of the transcript breakpoint, so its cached entry is never matched`
                  : "HEALTHY: no startup side effects, and the transcript carries a breakpoint with everything ahead of it stable";
  console.log(`verdict:        ${verdict}`);
  return verdict.startsWith("HEALTHY");
}

const options = parseOptions(process.argv.slice(2));
const executable = options.claude ?? claudeExecutable();
const imageStore = new SessionImageStore();
imageStore.open();
const home = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-capture-home-"));
const markerRoot = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-capture-marker-"));
let captures;
let startup;
let fixture;
try {
  fixture = await createProjectFixture(markerRoot);
  const before = await snapshotTree(fixture.project);
  captures = [
    await captureOnce(options, executable, home, fixture.project, imageStore),
    await captureOnce(options, executable, home, fixture.project, imageStore),
  ];
  const after = await snapshotTree(fixture.project);
  startup = {
    project: await realpath(fixture.project),
    filterProbe: fixture.filterProbe,
    filterRan: existsSync(fixture.marker),
    changedFiles: [...new Set([...before.keys(), ...after.keys()])].filter((name) => before.get(name) !== after.get(name)),
  };
} finally {
  await imageStore.close();
  await Promise.all([home, markerRoot, fixture?.project].filter(Boolean).map((path) => rm(path, { recursive: true, force: true })));
}
const healthy = report(captures, options, startup);
if (options.output) {
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(captures.at(-1).body, null, 2)}\n`);
  console.log(`wrote:          ${options.output}`);
}
process.exitCode = healthy ? 0 : 1;
