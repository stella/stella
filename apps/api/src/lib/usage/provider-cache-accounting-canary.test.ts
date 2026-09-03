import { describe, expect, test } from "bun:test";

/**
 * Canary tests binding PROVIDER_CACHE_ACCOUNTING (unit-model.ts) to the
 * REAL adapter usage builders, not to hand-written fixtures that restate the
 * map's own assumptions. Each test feeds a production-shaped provider usage
 * payload through the adapter code that ships to production and asserts the
 * relationship between `promptTokens` and `promptTokensDetails.cachedTokens`
 * that the accounting map encodes for that provider.
 *
 * The usage builders are internal modules, deliberately imported by dist file
 * path because the packages' exports maps do not expose them. That fragility
 * is the point of a canary: an adapter upgrade that moves or reshapes the
 * builder fails these imports loudly, forcing the accounting map to be
 * re-verified against the new adapter behavior instead of drifting silently.
 *
 * Providers not exercised here: the bedrock and openai adapters currently
 * emit no `cachedTokens` at all (verified against their dist output), so
 * their map entries cannot mis-meter today; if an upgrade adds cache fields,
 * the anomaly telemetry (`cache-tokens-exceed-included-prompt`) is the runtime
 * backstop until a canary is added for them.
 */
import { buildAnthropicUsage } from "../../../../../node_modules/@tanstack/ai-anthropic/dist/esm/usage.js";
import { buildGeminiUsage } from "../../../../../node_modules/@tanstack/ai-gemini/dist/esm/usage.js";

describe("provider cache accounting canaries", () => {
  test("anthropic adapter reports cache reads SEPARATE from input_tokens", () => {
    // Production-shaped Anthropic usage on a warm cache: input_tokens
    // excludes cache reads, so the cached count legitimately dwarfs it.
    const usage = buildAnthropicUsage({
      cache_creation: null,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 18_874,
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
    // separate-from-input: promptTokens stays the uncached count and the
    // cache reads ride promptTokensDetails without being folded in.
    expect(usage.promptTokens).toBe(5);
    expect(usage.promptTokensDetails?.cachedTokens).toBe(18_874);
  });

  test("anthropic adapter keeps cache writes out of promptTokens too", () => {
    const usage = buildAnthropicUsage({
      cache_creation: null,
      cache_creation_input_tokens: 9502,
      cache_read_input_tokens: 0,
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
    expect(usage.promptTokens).toBe(12);
    expect(usage.promptTokensDetails?.cacheWriteTokens).toBe(9502);
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
