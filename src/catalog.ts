import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { ClaudeSubscriptionType } from "./types.ts";

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
 * Opus is the only alias whose context window varies by subscription; the rest
 * are the same on every tier. That is evidence, not an omission: the paid model
 * matrix asserts the window Claude Code reports equals the one configured here,
 * and it has passed on a Pro subscription, the most restrictive tier. See
 * DEVELOPING.md for the baseline the gate runs against.
 *
 * The captured request fixtures disagree, and are not evidence: they are taken
 * against a loopback server with a dummy token, where Claude Code resolves no
 * subscription and reports its unauthenticated default.
 *
 * The doctor reports a served window that stops matching the configured one,
 * because the budget checks in src/provider.ts bound a request against the
 * configured value.
 */
export function providerModelsForSubscription(subscriptionType: ClaudeSubscriptionType): ProviderModelConfig[] {
  // Pro retains 200K even when Claude Code reports a 1M-capable Opus variant,
  // because this package cannot determine whether usage credits are available.
  const opusContextWindow = subscriptionType === "pro" ? 200_000 : 1_000_000;
  return [
    providerModel("sonnet", "Claude Code Sonnet", 1_000_000, 64_000),
    providerModel("fable", "Claude Code Fable", 1_000_000, 64_000),
    providerModel("opus", "Claude Code Opus", opusContextWindow, 64_000),
    providerModel("haiku", "Claude Code Haiku", 200_000, 32_000),
  ];
}
