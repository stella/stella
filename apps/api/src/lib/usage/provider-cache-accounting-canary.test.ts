import { describe, expect, test } from "bun:test";

/**
 * Bind canonical total-input accounting to the real adapter usage builders.
 * Provider-native counts pass through the shipped adapter before the ledger
 * splits uncached input, cache reads and cache writes.
 *
 * The usage builders are internal modules, deliberately imported by dist file
 * path because the packages' exports maps do not expose them. That fragility
 * is the point of a canary: an adapter upgrade that moves or reshapes the
 * builder fails these imports loudly, forcing the accounting boundary to be
 * re-verified against the new adapter behavior instead of drifting silently.
 *
 */
import { buildAnthropicUsage } from "../../../../../node_modules/@tanstack/ai-anthropic/dist/esm/usage.js";
import { buildGeminiUsage } from "../../../../../node_modules/@tanstack/ai-gemini/dist/esm/usage.js";
import { normalizeProviderPromptTokens } from "./unit-model";

describe("provider cache accounting canaries", () => {
  test("anthropic adapter includes cache reads in canonical prompt tokens", () => {
    // Production-shaped Anthropic usage on a warm cache: input_tokens
    // excludes cache reads, so the cached count legitimately dwarfs it.
    const usage = buildAnthropicUsage({
      cache_creation: null,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 18_874,
      fallback_credit: null,
      output_tokens_details: null,
      inference_geo: null,
      input_tokens: 5,
      iterations: null,
      output_tokens: 421,
      server_tool_use: null,
      service_tier: null,
      speed: null,
    });
    if (usage === undefined) {
      throw new Error("adapter returned no usage for a present usage object");
    }
    expect(usage.promptTokens).toBe(18_879);
    expect(usage.promptTokensDetails?.cachedTokens).toBe(18_874);
    expect(
      normalizeProviderPromptTokens({
        provider: "anthropic",
        modelId: "cache-accounting-canary",
        promptTokens: usage.promptTokens,
        cacheReadTokens: usage.promptTokensDetails?.cachedTokens ?? 0,
        cacheWriteTokens: usage.promptTokensDetails?.cacheWriteTokens ?? 0,
      }),
    ).toEqual({
      uncachedInputTokens: 5,
      cacheReadTokens: 18_874,
      cacheWriteTokens: 0,
    });
  });

  test("anthropic adapter includes cache writes without billing them twice", () => {
    const usage = buildAnthropicUsage({
      cache_creation: null,
      cache_creation_input_tokens: 9502,
      cache_read_input_tokens: 0,
      fallback_credit: null,
      output_tokens_details: null,
      inference_geo: null,
      input_tokens: 12,
      iterations: null,
      output_tokens: 50,
      server_tool_use: null,
      service_tier: null,
      speed: null,
    });
    if (usage === undefined) {
      throw new Error("adapter returned no usage for a present usage object");
    }
    expect(usage.promptTokens).toBe(9514);
    expect(usage.promptTokensDetails?.cacheWriteTokens).toBe(9502);
    expect(
      normalizeProviderPromptTokens({
        provider: "anthropic",
        modelId: "cache-accounting-canary",
        promptTokens: usage.promptTokens,
        cacheReadTokens: usage.promptTokensDetails?.cachedTokens ?? 0,
        cacheWriteTokens: usage.promptTokensDetails?.cacheWriteTokens ?? 0,
      }),
    ).toEqual({
      uncachedInputTokens: 12,
      cacheReadTokens: 0,
      cacheWriteTokens: 9502,
    });
  });

  test("gemini adapter reports cache reads INCLUDED in promptTokenCount", () => {
    // Production-shaped Gemini usageMetadata: promptTokenCount is the total
    // prompt INCLUDING cachedContentTokenCount.
    const usage = buildGeminiUsage({
      promptTokenCount: 21_000,
      candidatesTokenCount: 300,
      totalTokenCount: 21_300,
      cachedContentTokenCount: 18_874,
    });
    if (usage === undefined) {
      throw new Error("adapter returned no usage for a present usage object");
    }
    // included-in-input: the cached count is a subset of promptTokens.
    expect(usage.promptTokens).toBe(21_000);
    expect(usage.promptTokensDetails?.cachedTokens).toBe(18_874);
    const cached = usage.promptTokensDetails?.cachedTokens ?? 0;
    expect(cached).toBeLessThanOrEqual(usage.promptTokens);
  });
});
