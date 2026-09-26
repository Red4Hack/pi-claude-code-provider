// Capture Claude Code's help output verbatim so capability tests run against a
// document the CLI really produces. A hand-written fixture drifts silently and
// invents spellings the CLI has never emitted, which is how a load-bearing
// special case ended up in preflight.
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { claudeExecutable } from "../src/auth.ts";
import { SURFACE_CASES, captureSurfaceCase, surfaceErrors } from "./lib/claude-surface.js";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const directory = join(root, "test", "support", "captured");
const argv = process.argv.slice(2);
const print = argv.includes("--print");
const cliIndex = argv.indexOf("--claude");
const executable = cliIndex === -1 ? claudeExecutable() : argv[cliIndex + 1];
const validArgs = argv.filter((_, index) => cliIndex === -1 || (index !== cliIndex && index !== cliIndex + 1));
if (!executable || validArgs.some((arg) => arg !== "--print")) {
  throw new Error("Usage: capture:claude-surface [--print] [--claude <executable>]");
}

const [{ stdout: versionOutput }, { stdout: help }] = await Promise.all([
  execFileAsync(executable, ["--version"], { timeout: 10_000, maxBuffer: 1024 * 1024 }),
  execFileAsync(executable, ["--help"], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }),
]);

// Take the version from the binary rather than an argument, so an artifact can
// never claim a version it was not produced by.
const version = versionOutput.trim().match(/\d+\.\d+\.\d+/)?.[0];
if (!version) throw new Error(`Could not determine the Claude Code version from: ${versionOutput.trim()}`);
if (!help.includes("--print")) throw new Error("Captured help does not look like Claude Code's help output");

if (!print) await mkdir(directory, { recursive: true });
const path = join(directory, `claude-${version}-help.txt`);
if (!print) await writeFile(path, help);
console.log(print
  ? `Read ${Buffer.byteLength(help)} bytes of ${executable} --help (${version}); no artifact written`
  : `Captured ${Buffer.byteLength(help)} bytes of ${executable} --help (${version}) to ${relative(root, path)}`);
if (!print) console.log("Review help before changing CAPTURED_CLAUDE_VERSION; startup reports have their own producing version.");

const cases = [];
const failures = [];
for (const entry of SURFACE_CASES) {
  const label = `${entry.model}:${entry.effort ?? "default"}`;
  try {
    const captured = await captureSurfaceCase(executable, entry);
    cases.push(captured);
    const errors = surfaceErrors(captured);
    if (captured.initialization?.claude_code_version !== version) errors.push("initialization version differs from --version");
    failures.push(...errors.map((error) => `${label}: ${error}`));
    console.log(`${label}: effort ${captured.observedEffort ?? "omitted"}; plugins ${JSON.stringify(captured.initialization?.plugins ?? null)}; pre-init ${JSON.stringify(captured.preInitRecords)}`);
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
  }
}
const report = `${JSON.stringify({ version, cases, failures }, null, 2)}\n`;
const surfacePath = join(directory, `claude-${version}-surface.json`);
if (print) console.log(report);
else {
  await writeFile(surfacePath, report);
  console.log(`Startup and effort surface: ${relative(root, surfacePath)}`);
}
if (failures.length) throw new Error(failures.join("\n"));
console.log("Startup isolation and all effort wire checks passed (no quota used).");
