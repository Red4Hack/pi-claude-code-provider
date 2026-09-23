import { fileURLToPath } from "node:url";
import { ClaudeCodeError } from "./errors.ts";
import { scriptLaunch, type ScriptLaunch } from "./host-runtime.ts";
import type { PreparedRequest } from "./types.ts";

// Empty setting sources plus explicit settings preserve subscription authentication
// while suppressing user and project customizations. --bare would disable OAuth,
// and --safe-mode would disable the proposal MCP server.
// Claude Code otherwise appends a changing <total_tokens> reminder that breaks
// append-only cache reuse across this provider's fresh print-mode processes.
const SETTINGS = JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false, totalTokensReminder: "off" });
export const EMPTY_MCP = JSON.stringify({ mcpServers: {} });
export const BRIDGE_PATH = fileURLToPath(new URL("../bridge/mcp-proposal-server.js", import.meta.url));

// Claude Code places no cache breakpoint inside the history this provider
// replays, so the provider marks the last history block itself. The 1h
// TTL is required by the API's longest-TTL-first ordering, not chosen for its
// lifetime. DESIGN.md#compatibility-and-performance has the full account and cost.
const TRANSCRIPT_CACHE_CONTROL = { type: "ephemeral", ttl: "1h" } as const;

/**
 * Escape hatch for a Claude Code release that leaves no room for this breakpoint:
 * every Claude 5 alias already carries the API's maximum of four.
 */
export const TRANSCRIPT_BREAKPOINT_ENV = "PI_CLAUDE_CODE_PROVIDER_TRANSCRIPT_BREAKPOINT";

/** Unset or `on` keeps the transcript breakpoint; `off` drops it. */
export function transcriptBreakpointEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  const raw = environment[TRANSCRIPT_BREAKPOINT_ENV]?.trim();
  if (!raw || raw === "on") return true;
  if (raw === "off") return false;
  throw new ClaudeCodeError("breakpoint_config", `${TRANSCRIPT_BREAKPOINT_ENV} must be "on" or "off"`);
}

/**
 * Claude 5 and Opus 4.7+ return thinking blocks whose text is empty unless the
 * request asks for summarized display, so Pi shows a signature and nothing else.
 * `--thinking-display` is hidden from `--help` on purpose, which is also why it
 * is absent from REQUIRED_HEADLESS_FLAGS; `off` is the escape hatch for a
 * release that changes it.
 */
const THINKING_DISPLAY_ENV = "PI_CLAUDE_CODE_PROVIDER_THINKING_DISPLAY";

/** Unset or `summarized` shows thinking text; `omitted` hides it; `off` sends no flag. */
export function thinkingDisplay(environment: NodeJS.ProcessEnv = process.env): "summarized" | "omitted" | undefined {
  const raw = environment[THINKING_DISPLAY_ENV]?.trim();
  if (!raw || raw === "summarized") return "summarized";
  if (raw === "omitted") return "omitted";
  if (raw === "off") return undefined;
  throw new ClaudeCodeError("thinking_display_config", `${THINKING_DISPLAY_ENV} must be "summarized", "omitted", or "off"`);
}

interface PromptBlock {
  type: "text";
  text: string;
  cache_control?: typeof TRANSCRIPT_CACHE_CONTROL;
}

/** The single owner of how the proposal bridge is launched on either Pi distribution. */
export function bridgeLaunch(bunConfigPath?: string): ScriptLaunch {
  return scriptLaunch(BRIDGE_PATH, [], bunConfigPath);
}

/** Exact argv Claude Code receives for the proposal bridge. */
export function bridgeArgv(bunConfigPath?: string): string[] {
  const launch = bridgeLaunch(bunConfigPath);
  return [launch.command, ...launch.args];
}

export function formatBridgeArgv(argv: readonly string[]): string {
  return JSON.stringify(argv);
}

export function baseClaudeArgs(): string[] {
  return [
    "-p",
    "--setting-sources",
    "",
    "--settings",
    SETTINGS,
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--permission-mode",
    "dontAsk",
    "--no-chrome",
    "--no-session-persistence",
    "--prompt-suggestions",
    "false",
  ];
}

export function providerArgs(
  prepared: PreparedRequest,
  model: string,
  effort: string,
  options: { transcriptBreakpoint?: boolean; thinkingDisplay?: "summarized" | "omitted" } = {},
): { args: string[]; prompt: PromptBlock[] } {
  // Quoted absolute references: Claude runs in Pi's session directory, where a
  // relative reference would resolve against the project, and the quotes keep a
  // temporary root containing spaces in one reference.
  const imageRefs = prepared.attachmentPaths.map((path) => `@"${path}"`).join(" ");
  const imageInstruction = imageRefs
    ? ` Generated image attachments for image_attachment blocks: ${imageRefs}.`
    : "";
  // Keep the attachment list after unchanged history and outside the breakpoint.
  // Claude Code narrates image reads ahead of the transcript, so the paths must
  // also stay stable across requests for that earlier prefix to be reusable.
  const markedBlock = options.transcriptBreakpoint === false ? -1 : prepared.transcriptBlocks.length - 1;
  const prompt: PromptBlock[] = [
    ...prepared.transcriptBlocks.map((text, index) => ({
      type: "text" as const,
      text,
      ...(index === markedBlock ? { cache_control: TRANSCRIPT_CACHE_CONTROL } : {}),
    })),
    ...(imageInstruction ? [{ type: "text" as const, text: imageInstruction.trim() }] : []),
  ];
  const bridge = bridgeLaunch(prepared.bunConfigPath);
  const mcpConfig = prepared.catalogPath
    ? JSON.stringify({
        mcpServers: {
          pi: {
            command: bridge.command,
            args: bridge.args,
            env: {
              ...bridge.env,
              PI_CLAUDE_TOOL_CATALOG: prepared.catalogPath,
              PI_CLAUDE_TOOL_VIOLATION: prepared.violationPath,
              PI_CLAUDE_TOOL_READY: prepared.readyPath,
            },
          },
        },
      })
    : EMPTY_MCP;
  // Keep the system prompt out of process arguments and avoid command-line size limits.
  const args = [
    ...baseClaudeArgs(),
    "--mcp-config",
    mcpConfig,
    "--tools",
    "",
    "--model",
    model,
    ...(model === "haiku" ? [] : ["--effort", effort]),
    ...(options.thinkingDisplay ? ["--thinking-display", options.thinkingDisplay] : []),
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--system-prompt-file",
    prepared.systemPromptPath,
  ];
  return { args, prompt };
}
