import { spawn } from "node:child_process";
import { buildClaudeEnvironment, claudeLaunch } from "../../src/auth.ts";
import { terminateProcessGroup } from "../../src/process-utils.ts";

/** Dummy authentication belongs only to a loopback capture, never a provider. */
export function captureEnvironment(home, baseUrl, extra = {}) {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error("Claude captures require an HTTP loopback server");
  }
  const env = {
    ...buildClaudeEnvironment({ ...extra, HOME: home }),
    ANTHROPIC_BASE_URL: baseUrl,
    CLAUDE_CODE_OAUTH_TOKEN: "local-capture-dummy-oauth-token",
  };
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "CLAUDE_CONFIG_DIR"]) delete env[name];
  // Windows homedir() uses USERPROFILE; keep its injected default from exposing
  // the real account when a native CLI follows that instead of HOME.
  if (process.platform === "win32") env.USERPROFILE = home;
  return env;
}

export async function captureTimeout(pending, label, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Subscribe before writing stdin, so even a fast exit is observed through close. */
export function spawnCaptureChild(executable, args, { cwd, env, stdio = ["pipe", "pipe", "pipe"] }) {
  const launch = claudeLaunch(executable, args);
  const child = spawn(launch.command, launch.args, {
    cwd, env: { ...env, ...launch.env }, stdio,
    detached: process.platform !== "win32", windowsHide: process.platform === "win32",
  });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  // A failed spawn can precede the caller's first await; retain it for that await.
  void closed.catch(() => {});
  const capture = { child, closed, stdinError: undefined };
  child.stdin?.on("error", (error) => { capture.stdinError = error; });
  return capture;
}

/** Let normal shutdown finish writing its private HOME, then kill an owned tree. */
export async function stopCaptureChild(process, graceMs = 5_000) {
  let timer;
  try {
    const closed = await Promise.race([
      process.closed.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), graceMs); }),
    ]);
    if (!closed) await terminateProcessGroup(process.child);
    await captureTimeout(process.closed, "capture process cleanup", graceMs);
  } finally {
    clearTimeout(timer);
  }
}
