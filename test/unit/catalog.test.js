import assert from "node:assert/strict";
import test from "node:test";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { providerModels } from "../../src/catalog.ts";

test("advertises each alias with Claude Code's own context window and default output cap", () => {
    // The same on every subscription tier: Claude Code serves Opus 5.5 with its
    // native 1M window on Pro too, so nothing here depends on the account.
    const models = providerModels();
    assert.deepEqual(
        models.map(({ id, name, contextWindow, maxTokens }) => ({ id, name, contextWindow, maxTokens })),
        [
            { id: "sonnet", name: "Claude Code Sonnet", contextWindow: 1_000_000, maxTokens: 128_000 },
            { id: "fable", name: "Claude Code Fable", contextWindow: 1_000_000, maxTokens: 64_000 },
            { id: "opus", name: "Claude Code Opus", contextWindow: 1_000_000, maxTokens: 128_000 },
            { id: "haiku", name: "Claude Code Haiku", contextWindow: 1_000_000, maxTokens: 128_000 },
        ],
    );
    for (const model of models) {
        assert.deepEqual(model.input, ["text", "image"]);
        assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
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
});

test("builds one model per discovered alias, with conservative limits for unknown ones", () => {
    const models = providerModels(["opus", "zeta"]);
    assert.deepEqual(models.map(({ id, name, contextWindow, maxTokens }) => ({ id, name, contextWindow, maxTokens })), [
        { id: "opus", name: "Claude Code Opus", contextWindow: 1_000_000, maxTokens: 128_000 },
        { id: "zeta", name: "Claude Code Zeta", contextWindow: 200_000, maxTokens: 32_000 },
    ]);
});

test("limits and effort support come from Claude Code's own table when it is readable", () => {
    const [model] = providerModels(["haiku"], { haiku: "claude-haiku-9" }, { "claude-haiku-9": { contextWindow: 2_000_000, maxTokens: 256_000, effort: false } });
    assert.equal(model.contextWindow, 2_000_000);
    assert.equal(model.maxTokens, 256_000);
    assert.equal(model.reasoning, false);
});
