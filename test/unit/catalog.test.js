import assert from "node:assert/strict";
import test from "node:test";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { providerModelsForSubscription } from "../../src/catalog.ts";

test("derives only the Opus context window from the subscription type", () => {
    for (const subscriptionType of ["pro", "max", "team", "enterprise"]) {
        const models = providerModelsForSubscription(subscriptionType);
        assert.deepEqual(
            models.map(({ id, name, contextWindow, maxTokens }) => ({ id, name, contextWindow, maxTokens })),
            [
                { id: "sonnet", name: "Claude Code Sonnet", contextWindow: 1_000_000, maxTokens: 64_000 },
                { id: "fable", name: "Claude Code Fable", contextWindow: 1_000_000, maxTokens: 64_000 },
                { id: "opus", name: "Claude Code Opus", contextWindow: subscriptionType === "pro" ? 200_000 : 1_000_000, maxTokens: 64_000 },
                { id: "haiku", name: "Claude Code Haiku", contextWindow: 200_000, maxTokens: 32_000 },
            ],
        );
        for (const model of models) {
            assert.deepEqual(model.input, ["text", "image"]);
            assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
            if (model.id === "haiku") {
                assert.equal(model.reasoning, false);
                assert.equal(model.thinkingLevelMap, undefined);
                assert.deepEqual(getSupportedThinkingLevels(model), ["off"]);
                continue;
            }
            assert.equal(model.reasoning, true);
            assert.deepEqual(model.thinkingLevelMap, {
                off: null,
                minimal: null,
                low: "low",
                medium: "medium",
                high: "high",
                xhigh: "xhigh",
                max: "max",
            });
            assert.deepEqual(getSupportedThinkingLevels(model), ["low", "medium", "high", "xhigh", "max"]);
        }
    }
});
