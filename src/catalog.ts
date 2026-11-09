import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { ModelAliasVersions, ModelLimitTable } from "./claude-models.ts";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const EFFORT_LEVELS = {
  off: null,
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
} as const;

// Limits Claude Code serves for the aliases seen so far. An alias not listed
// here gets the conservative default: Pi compacts early rather than overflowing,
// and the doctor reports a served window that differs from the configured one.
const KNOWN_LIMITS: Record<string, readonly [contextWindow: number, maxTokens: number]> = {
  sonnet: [1_000_000, 128_000],
  fable: [1_000_000, 64_000],
  opus: [1_000_000, 128_000],
  haiku: [1_000_000, 128_000],
};
const DEFAULT_LIMITS = [200_000, 32_000] as const;

function providerModel(id: string, versions: ModelAliasVersions, table: ModelLimitTable): ProviderModelConfig {
  // Claude Code's own table for the model this alias serves wins; the constants
  // are only the fallback when the executable cannot be read.
  const served = table[versions[id] ?? ""];
  const [contextWindow, maxTokens] = served ? [served.contextWindow, served.maxTokens] : KNOWN_LIMITS[id] ?? DEFAULT_LIMITS;
  const effort = served ? served.effort : true;
  return {
    id,
    name: `Claude Code ${id[0]!.toUpperCase()}${id.slice(1)}${versions[id] ? ` (${versions[id]})` : ""}`,
    // Haiku has no effort control. Claude Code still owns its thinking default.
    ...(effort ? { reasoning: true, thinkingLevelMap: EFFORT_LEVELS } : { reasoning: false }),
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow,
    maxTokens,
  };
}

/**
 * One model per alias in Claude Code's own alias table, so a new model needs no
 * change here. Every alias has the same context window on every subscription
 * tier: Claude Code serves Sonnet, Fable, and Opus with their native 1M window
 * on Pro as well as Max, Team, and Enterprise. The window needs no usage
 * credits, though Fable itself does on Pro. Each
 * maxTokens is Claude Code's own default output cap for the model the alias
 * serves. The paid model matrix asserts both against what Claude Code reports
 * for a real login; see DEVELOPING.md for the baseline the gate runs against.
 *
 * The captured request fixtures disagree, and are not evidence: they are taken
 * against a loopback server with a dummy token, where Claude Code resolves no
 * subscription and reports its unauthenticated default.
 *
 * The doctor reports a served window that stops matching the configured one,
 * because Pi places its compaction threshold by the configured value.
 */
export function providerModels(
  aliases: readonly string[] = [],
  versions: ModelAliasVersions = {},
  table: ModelLimitTable = {},
): ProviderModelConfig[] {
  // shortcut: the list comes from Claude Code's own alias table; with none found
  // (unreadable binary, changed table shape) fall back to the aliases known today.
  return (aliases.length > 0 ? aliases : Object.keys(KNOWN_LIMITS)).map((id) => providerModel(id, versions, table));
}
