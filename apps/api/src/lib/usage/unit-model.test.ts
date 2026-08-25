import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const captureErrorMock = mock();

const realCapture = await import("@/api/lib/analytics/capture");
void mock.module("@/api/lib/analytics/capture", () => ({
  ...realCapture,
  captureError: captureErrorMock,
  captureRequestError: captureErrorMock,
}));

const {
  computeRawUsageMicroUnits,
  normalizeProviderPromptTokens,
  usageUnitsFromTokens,
  MICRO_UNITS_PER_USAGE_UNIT,
} = await import("@/api/lib/usage/unit-model");
const { MODEL_RATES } = await import("@stll/ai-catalog");

beforeEach(() => {
  captureErrorMock.mockReset();
});

// Bun runs every test file in one process, and `mock.module` mutates a
// shared registry: without restoring here, this call would leak into
// whichever other test file runs next in the same process.
afterAll(() => {
  mock.restore();
});

describe("computeRawUsageMicroUnits", () => {
  test("scales linearly in input + output tokens", () => {
    const small = computeRawUsageMicroUnits({
      modelId: "gemini-2.5-flash",
      uncachedInputTokens: 1000,
      outputTokens: 1000,
    });
    const large = computeRawUsageMicroUnits({
      modelId: "gemini-2.5-flash",
      uncachedInputTokens: 100_000,
      outputTokens: 100_000,
    });
    expect(large).toBeGreaterThan(small);
    // Allow a little ceiling-rounding slack.
    expect(large).toBeGreaterThanOrEqual(small * 99);
  });

  test("cached input tokens use the adjusted rate", () => {
    const noCache = computeRawUsageMicroUnits({
      modelId: "gemini-2.5-flash",
      uncachedInputTokens: 100_000,
      outputTokens: 0,
    });
    const withCache = computeRawUsageMicroUnits({
      modelId: "gemini-2.5-flash",
      uncachedInputTokens: 10_000,
      outputTokens: 0,
      cacheReadTokens: 90_000,
    });
    expect(withCache).toBeLessThan(noCache);
  });

  // Every tiered schedule, pinned at and just past its threshold: exactly at
  // the threshold stays on the standard rate, one token past it reprices the
  // whole request.
  const TIER_BOUNDARY_UNITS = {
    "gemini-3.1-pro-preview": [200_000, 41_200, 81_801],
    "gpt-5.4": [272_000, 69_500, 138_251],
    "gpt-5.5": [272_000, 139_000, 276_501],
    "gpt-5.6": [272_000, 110_800, 220_601],
    "gpt-5.6-luna": [272_000, 5560, 11_061],
    "gpt-5.6-terra": [272_000, 55_600, 110_601],
  } as const;

  test("the tier boundary table covers exactly the tiered rate schedules", () => {
    const tiered = Object.entries(MODEL_RATES).flatMap(([modelId, rate]) =>
      rate.kind === "input-token-tiered"
        ? [[modelId, rate.inputTokenThreshold] as const]
        : [],
    );
    const pinned = Object.entries(TIER_BOUNDARY_UNITS).map(
      ([modelId, [threshold]]) => [modelId, threshold] as const,
    );
    expect(new Map(tiered)).toEqual(new Map(pinned));
  });

  for (const [
    modelId,
    [threshold, atThresholdUnits, aboveThresholdUnits],
  ] of Object.entries(TIER_BOUNDARY_UNITS)) {
    test(`${modelId} switches the entire request above ${String(threshold)} input tokens`, () => {
      const atThreshold = computeRawUsageMicroUnits({
        modelId,
        uncachedInputTokens: threshold,
        outputTokens: 1000,
      });
      const aboveThreshold = computeRawUsageMicroUnits({
        modelId,
        uncachedInputTokens: threshold + 1,
        outputTokens: 1000,
      });

      expect(atThreshold).toBe(atThresholdUnits);
      expect(aboveThreshold).toBe(aboveThresholdUnits);
    });
  }

  test("GPT-5.6 applies its long-context multiplier to cached input", () => {
    // Tier resolution counts cached prompt tokens too: 300K cached reads
    // alone push the request over the 272K threshold.
    expect(
      computeRawUsageMicroUnits({
        modelId: "gpt-5.6",
        uncachedInputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 300_000,
      }),
    ).toBe(24_000);
  });

  test("GPT-5.6 Sol canonical ID shares the alias rate schedule", () => {
    const usage = {
      uncachedInputTokens: 300_000,
      outputTokens: 10_000,
    };
    expect(
      computeRawUsageMicroUnits({ modelId: "gpt-5.6-sol", ...usage }),
    ).toBe(computeRawUsageMicroUnits({ modelId: "gpt-5.6", ...usage }));
  });

  test("unknown models use the conservative fallback rate", () => {
    const units = computeRawUsageMicroUnits({
      modelId: "unknown-model-name",
      uncachedInputTokens: 10_000,
      outputTokens: 10_000,
    });
    expect(units).toBeGreaterThan(0);
  });

  test("zero tokens produce zero raw units", () => {
    expect(
      computeRawUsageMicroUnits({
        modelId: "gemini-2.5-flash",
        uncachedInputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe(0);
  });

  test("meters malformed token counts conservatively without throwing", () => {
    // Each malformed field must coerce (never throw), report the shape,
    // and leave the well-formed fields metered normally.
    const invalidCounts = [-1, Number.NaN, Number.NEGATIVE_INFINITY];
    const fields = [
      "uncachedInputTokens",
      "outputTokens",
      "cacheReadTokens",
    ] as const;
    const baseline = computeRawUsageMicroUnits({
      modelId: "gemini-2.5-flash",
      uncachedInputTokens: 100,
      outputTokens: 100,
      cacheReadTokens: 0,
    });

    for (const field of fields) {
      for (const invalidCount of invalidCounts) {
        const units = computeRawUsageMicroUnits({
          modelId: "gemini-2.5-flash",
          uncachedInputTokens: 100,
          outputTokens: 100,
          cacheReadTokens: 0,
          [field]: invalidCount,
        });
        // The malformed field meters as 0; the others stay billed.
        expect(units).toBeGreaterThanOrEqual(0);
        expect(units).toBeLessThanOrEqual(baseline);
      }
    }
    expect(captureErrorMock).toHaveBeenCalled();

    // +Infinity is an oversized positive count, not an absent one: it must
    // clamp to the ceiling (over-metering), never coerce to zero.
    for (const field of fields) {
      const units = computeRawUsageMicroUnits({
        modelId: "gemini-2.5-flash",
        uncachedInputTokens: 100,
        outputTokens: 100,
        cacheReadTokens: 0,
        [field]: Number.POSITIVE_INFINITY,
      });
      expect(units).toBeGreaterThan(baseline);
    }
  });

  test("rounds fractional token counts up", () => {
    // Anomaly telemetry dedupes per model id, so this test uses a model
    // the malformed-count test above did not touch.
    expect(
      computeRawUsageMicroUnits({
        modelId: "gemini-2.5-pro",
        uncachedInputTokens: 0.5,
        outputTokens: 0,
      }),
    ).toBe(
      computeRawUsageMicroUnits({
        modelId: "gemini-2.5-pro",
        uncachedInputTokens: 1,
        outputTokens: 0,
      }),
    );
    expect(captureErrorMock).toHaveBeenCalled();
  });

  test("clamps absurdly large counts instead of overflowing", () => {
    // 2^40 caps every component, so even MAX_SAFE_INTEGER tokens meter
    // to a finite conservative amount with telemetry, never a crash.
    const units = computeRawUsageMicroUnits({
      modelId: "unknown-model-name",
      uncachedInputTokens: 0,
      outputTokens: Number.MAX_SAFE_INTEGER,
    });
    expect(Number.isSafeInteger(units)).toBe(true);
    expect(units).toBe(2 ** 41);
    expect(captureErrorMock).toHaveBeenCalled();
  });

  test("keeps rate scaling exact when the intermediate product is unsafe", () => {
    // (2^40 - 2) * 500_000 exceeds 2^53, so float math would round;
    // the bigint path must stay exact.
    expect(
      computeRawUsageMicroUnits({
        modelId: "unknown-model-name",
        uncachedInputTokens: 2 ** 40 - 2,
        outputTokens: 0,
      }),
    ).toBe(2 ** 39 - 1);
  });
});

describe("normalizeProviderPromptTokens", () => {
  test("Anthropic warm cache: cache reads exceed input tokens legitimately", () => {
    // Production-shaped Anthropic usage on a warm cache: `input_tokens`
    // excludes cache reads and cache writes, so cached >> input.
    const normalized = normalizeProviderPromptTokens({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      promptTokens: 217,
      cacheReadTokens: 45_082,
      cacheWriteTokens: 1204,
    });

    expect(normalized).toEqual({
      // Cache writes are billable prompt tokens outside `input_tokens`.
      uncachedInputTokens: 217 + 1204,
      cacheReadTokens: 45_082,
    });
    expect(captureErrorMock).not.toHaveBeenCalled();

    // End to end: 1421 uncached at 200_000/MTok (285) + 45_082 cached at
    // 20_000/MTok (902) + 1538 output at 1_000_000/MTok (1538).
    expect(
      computeRawUsageMicroUnits({
        modelId: "claude-sonnet-5",
        outputTokens: 1538,
        ...normalized,
      }),
    ).toBe(285 + 902 + 1538);
  });

  test("OpenAI subset semantics: cached tokens split out of the prompt total", () => {
    // Production-shaped OpenAI usage: `prompt_tokens` includes
    // `prompt_tokens_details.cached_tokens` (1024-boundary multiples).
    const normalized = normalizeProviderPromptTokens({
      provider: "openai",
      modelId: "gpt-5.6",
      promptTokens: 32_512,
      cacheReadTokens: 31_744,
      cacheWriteTokens: 0,
    });

    expect(normalized).toEqual({
      uncachedInputTokens: 768,
      cacheReadTokens: 31_744,
    });
    expect(captureErrorMock).not.toHaveBeenCalled();

    // 768 uncached at 400_000/MTok (308) + 31_744 cached at 40_000/MTok
    // (1270) + 2048 output at 2_000_000/MTok (4096).
    expect(
      computeRawUsageMicroUnits({
        modelId: "gpt-5.6",
        outputTokens: 2048,
        ...normalized,
      }),
    ).toBe(308 + 1270 + 4096);
  });

  test("subset-semantics disagreement meters the full prompt and reports", () => {
    // An included-in-input provider claiming more cached than prompt
    // tokens is a shape disagreement: bill everything at the input rate,
    // never throw.
    const normalized = normalizeProviderPromptTokens({
      provider: "openai",
      modelId: "gpt-5.6-shape-disagreement",
      promptTokens: 1024,
      cacheReadTokens: 2048,
      cacheWriteTokens: 0,
    });

    // Shape disagreement falls back to separate accounting: full prompt at
    // the input rate AND the reported cache reads at the cache rate, so the
    // larger reported amount is never discarded (conservative direction).
    expect(normalized).toEqual({
      uncachedInputTokens: 1024,
      cacheReadTokens: 2048,
    });
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        anomaly: "cache-read-exceeds-included-prompt",
        source: "usage-unit-model",
      }),
    );
  });

  test("malformed provider counts coerce conservatively and report", () => {
    const normalized = normalizeProviderPromptTokens({
      provider: "anthropic",
      modelId: "claude-sonnet-5-malformed-shape",
      promptTokens: Number.NaN,
      cacheReadTokens: -512,
      cacheWriteTokens: 96.4,
    });

    // NaN and negative meter as 0; fractional rounds up.
    expect(normalized).toEqual({
      uncachedInputTokens: 97,
      cacheReadTokens: 0,
    });
    expect(captureErrorMock).toHaveBeenCalled();
  });

  test("anomaly telemetry dedupes per model id and anomaly", () => {
    const modelId = "claude-sonnet-5-anomaly-dedupe";
    const usage = {
      provider: "anthropic",
      modelId,
      promptTokens: -1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    } as const;

    normalizeProviderPromptTokens(usage);
    normalizeProviderPromptTokens(usage);

    expect(captureErrorMock).toHaveBeenCalledTimes(1);
  });
});

describe("usageUnitsFromTokens", () => {
  test("BYOK actions consume zero units but still report raw attribution", () => {
    const result = usageUnitsFromTokens({
      modelId: "gemini-2.5-flash",
      uncachedInputTokens: 10_000,
      outputTokens: 10_000,
      actionType: "chat",
      serviceTier: "standard",
      isByok: true,
    });
    expect(result.unitsConsumed).toBe(0);
    expect(result.rawUsageMicroUnits).toBeGreaterThan(0);
  });

  test("trivial calls floor at the action weight", () => {
    const result = usageUnitsFromTokens({
      modelId: "gemini-2.5-flash",
      uncachedInputTokens: 10,
      outputTokens: 10,
      actionType: "case_law",
      serviceTier: "flex",
      isByok: false,
    });
    // case_law weight is 8: even a tiny call should consume at
    // least that floor.
    expect(result.unitsConsumed).toBeGreaterThanOrEqual(8);
  });

  test("large calls consume more than the action floor", () => {
    const result = usageUnitsFromTokens({
      modelId: "gemini-2.5-pro",
      uncachedInputTokens: 500_000,
      outputTokens: 50_000,
      actionType: "chat",
      serviceTier: "standard",
      isByok: false,
    });
    // chat weight is 1; a half-million-token gemini-pro call
    // should consume far above 1.
    expect(result.unitsConsumed).toBeGreaterThan(100);
  });

  test("standard tier consumes more than flex tier for identical usage", () => {
    const usage = {
      modelId: "gemini-2.5-pro",
      uncachedInputTokens: 100_000,
      outputTokens: 10_000,
      actionType: "doc_review" as const,
      isByok: false,
    };
    const standard = usageUnitsFromTokens({
      ...usage,
      serviceTier: "standard",
    });
    const flex = usageUnitsFromTokens({ ...usage, serviceTier: "flex" });
    expect(standard.unitsConsumed).toBeGreaterThan(flex.unitsConsumed);
  });

  test("units derive from raw micro-units via the documented denomination", () => {
    const result = usageUnitsFromTokens({
      modelId: "gemini-2.5-pro",
      uncachedInputTokens: 100_000,
      outputTokens: 10_000,
      actionType: "chat",
      serviceTier: "flex",
      isByok: false,
    });
    // unitsConsumed >= ceil(raw micro-units / 100): the floor
    // (action weight) can push it above the raw conversion
    // but never below.
    expect(result.unitsConsumed).toBeGreaterThanOrEqual(
      Math.ceil(result.rawUsageMicroUnits / MICRO_UNITS_PER_USAGE_UNIT),
    );
  });
});

describe("catalog-miss telemetry", () => {
  test("reports a telemetry error once per unknown model id", () => {
    const modelId = "unit-model-test-unknown-model-once";

    computeRawUsageMicroUnits({
      modelId,
      outputTokens: 100,
      uncachedInputTokens: 100,
    });
    computeRawUsageMicroUnits({
      modelId,
      outputTokens: 200,
      uncachedInputTokens: 200,
    });

    // Deduped per process by model id: the second miss for the same id
    // must not capture again.
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ source: "usage-unit-model", modelId }),
    );
  });

  test("does not report telemetry for a model already in the rate catalog", () => {
    computeRawUsageMicroUnits({
      modelId: "gemini-2.5-flash",
      uncachedInputTokens: 100,
      outputTokens: 100,
    });

    expect(captureErrorMock).not.toHaveBeenCalled();
  });
});
