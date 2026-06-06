import { describe, expect, test } from "bun:test";

import {
  computeRawUsageMicroUnits,
  usageUnitsFromTokens,
  MICRO_UNITS_PER_USAGE_UNIT,
} from "@/api/lib/usage/unit-model";

describe("computeRawUsageMicroUnits", () => {
  test("scales linearly in input + output tokens", () => {
    const small = computeRawUsageMicroUnits({
      modelId: "gemini-2.5-flash",
      inputTokens: 1000,
      outputTokens: 1000,
    });
    const large = computeRawUsageMicroUnits({
      modelId: "gemini-2.5-flash",
      inputTokens: 100_000,
      outputTokens: 100_000,
    });
    expect(large).toBeGreaterThan(small);
    // Allow a little ceiling-rounding slack.
    expect(large).toBeGreaterThanOrEqual(small * 99);
  });

  test("cached input tokens use the adjusted rate", () => {
    const noCache = computeRawUsageMicroUnits({
      modelId: "gemini-2.5-flash",
      inputTokens: 100_000,
      outputTokens: 0,
    });
    const withCache = computeRawUsageMicroUnits({
      modelId: "gemini-2.5-flash",
      inputTokens: 100_000,
      outputTokens: 0,
      cacheReadTokens: 90_000,
    });
    expect(withCache).toBeLessThan(noCache);
  });

  test("unknown models use the conservative fallback rate", () => {
    const units = computeRawUsageMicroUnits({
      modelId: "unknown-model-name",
      inputTokens: 10_000,
      outputTokens: 10_000,
    });
    expect(units).toBeGreaterThan(0);
  });

  test("zero tokens produce zero raw units", () => {
    expect(
      computeRawUsageMicroUnits({
        modelId: "gemini-2.5-flash",
        inputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe(0);
  });

  test("panics on inconsistent token counts (cache > input)", () => {
    expect(() =>
      computeRawUsageMicroUnits({
        modelId: "gemini-2.5-flash",
        inputTokens: 100,
        outputTokens: 0,
        cacheReadTokens: 200,
      }),
    ).toThrow();
  });
});

describe("usageUnitsFromTokens", () => {
  test("BYOK actions consume zero units but still report raw attribution", () => {
    const result = usageUnitsFromTokens({
      modelId: "gemini-2.5-flash",
      inputTokens: 10_000,
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
      inputTokens: 10,
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
      inputTokens: 500_000,
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
      inputTokens: 100_000,
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
      inputTokens: 100_000,
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
