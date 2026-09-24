import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

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

function providerModel(
  id: string,
  name: string,
  contextWindow: number,
  maxTokens: number,
): ProviderModelConfig {
  return {
    id,
    name,
    // Haiku has no effort control. Claude Code still owns its thinking default.
    ...(id === "haiku" ? { reasoning: false } : { reasoning: true, thinkingLevelMap: EFFORT_LEVELS }),
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow,
    maxTokens,
  };
}

/**
 * Every alias has the same context window on every subscription tier: Claude
 * Code serves Sonnet 5, Fable 5.1, and Opus 5.5 with their native 1M window
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
 * because the budget checks in src/provider.ts bound a request against the
 * configured value.
 */
export function providerModels(): ProviderModelConfig[] {
  return [
    providerModel("sonnet", "Claude Code Sonnet", 1_000_000, 64_000),
    providerModel("fable", "Claude Code Fable", 1_000_000, 64_000),
    providerModel("opus", "Claude Code Opus", 1_000_000, 128_000),
    providerModel("haiku", "Claude Code Haiku", 200_000, 32_000),
  ];
}
