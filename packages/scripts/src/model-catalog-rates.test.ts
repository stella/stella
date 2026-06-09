import { describe, expect, test } from "bun:test";

import type { ModelRate } from "@stll/ai-catalog";

import { parseUpstreamCost, validateRates } from "./model-catalog-rates";
import type { UpstreamCost } from "./model-catalog-rates";

const FIRST_PARTY = { openai: "openai", anthropic: "anthropic" } as const;

// Factor 100_000 micro-units per upstream dollar, matching the live
// table's normalization.
const consistentRate = (input: number, output: number): ModelRate => ({
  inputPerMTok: input * 100_000,
  outputPerMTok: output * 100_000,
});

const cost = (
  input: number,
  output: number,
  cacheRead?: number,
): UpstreamCost => ({ input, output, cacheRead });

describe("validateRates", () => {
  test("flags an offered first-party model without a rate entry", () => {
    const { failures } = validateRates({
      entries: [{ provider: "openai", modelId: "gpt-x" }],
      firstPartyProviders: FIRST_PARTY,
      costs: new Map([["openai:gpt-x", cost(1, 2)]]),
      rates: {},
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.label).toBe("NO RATE");
  });

  test("ignores providers without a first-party mapping", () => {
    const result = validateRates({
      entries: [{ provider: "openrouter", modelId: "openai/gpt-x" }],
      firstPartyProviders: FIRST_PARTY,
      costs: new Map(),
      rates: {},
    });
    expect(result.failures).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  test("skips entries without upstream cost metadata", () => {
    const { failures, skipped } = validateRates({
      entries: [{ provider: "openai", modelId: "gpt-x" }],
      firstPartyProviders: FIRST_PARTY,
      costs: new Map(),
      rates: { "gpt-x": consistentRate(1, 2) },
    });
    expect(failures).toEqual([]);
    expect(skipped).toHaveLength(1);
  });

  test("accepts a mutually consistent table", () => {
    const { failures } = validateRates({
      entries: [
        { provider: "openai", modelId: "gpt-a" },
        { provider: "openai", modelId: "gpt-b" },
        { provider: "anthropic", modelId: "claude-c" },
      ],
      firstPartyProviders: FIRST_PARTY,
      costs: new Map([
        ["openai:gpt-a", cost(0.25, 2)],
        ["openai:gpt-b", cost(1, 4)],
        ["anthropic:claude-c", cost(3, 15)],
      ]),
      rates: {
        "gpt-a": consistentRate(0.25, 2),
        "gpt-b": consistentRate(1, 4),
        "claude-c": consistentRate(3, 15),
      },
    });
    expect(failures).toEqual([]);
  });

  test("flags only the drifted entry, with the drifted axes", () => {
    const { failures } = validateRates({
      entries: [
        { provider: "openai", modelId: "gpt-a" },
        { provider: "openai", modelId: "gpt-b" },
        { provider: "anthropic", modelId: "claude-c" },
      ],
      firstPartyProviders: FIRST_PARTY,
      costs: new Map([
        ["openai:gpt-a", cost(0.25, 2)],
        ["openai:gpt-b", cost(1, 4)],
        ["anthropic:claude-c", cost(3, 15)],
      ]),
      rates: {
        "gpt-a": consistentRate(0.25, 2),
        // Stale entry: copied from a predecessor model priced 3x higher.
        "gpt-b": consistentRate(3, 12),
        "claude-c": consistentRate(3, 15),
      },
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.entry.modelId).toBe("gpt-b");
    expect(failures[0]?.label).toBe("RATE DRIFT");
    expect(failures[0]?.detail).toContain("input, output");
  });

  test("tolerates sub-1% rounding differences", () => {
    const { failures } = validateRates({
      entries: [
        { provider: "openai", modelId: "gpt-a" },
        { provider: "openai", modelId: "gpt-b" },
      ],
      firstPartyProviders: FIRST_PARTY,
      costs: new Map([
        ["openai:gpt-a", cost(1, 4)],
        ["openai:gpt-b", cost(3, 12)],
      ]),
      rates: {
        "gpt-a": consistentRate(1, 4),
        "gpt-b": {
          inputPerMTok: Math.round(3 * 100_000 * 1.005),
          outputPerMTok: 12 * 100_000,
        },
      },
    });
    expect(failures).toEqual([]);
  });

  test("flags a missing cached rate when upstream prices cache reads", () => {
    const { failures } = validateRates({
      entries: [{ provider: "openai", modelId: "gpt-a" }],
      firstPartyProviders: FIRST_PARTY,
      costs: new Map([["openai:gpt-a", cost(1, 4, 0.1)]]),
      rates: { "gpt-a": consistentRate(1, 4) },
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.label).toBe("NO CACHED RATE");
  });

  test("validates the cached-input axis against upstream cache pricing", () => {
    const { failures } = validateRates({
      entries: [
        { provider: "openai", modelId: "gpt-a" },
        { provider: "openai", modelId: "gpt-b" },
      ],
      firstPartyProviders: FIRST_PARTY,
      costs: new Map([
        ["openai:gpt-a", cost(1, 4, 0.1)],
        ["openai:gpt-b", cost(2, 8, 0.2)],
      ]),
      rates: {
        "gpt-a": { ...consistentRate(1, 4), cachedInputPerMTok: 10_000 },
        // Cache rate stale by 5x.
        "gpt-b": { ...consistentRate(2, 8), cachedInputPerMTok: 100_000 },
      },
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.entry.modelId).toBe("gpt-b");
    expect(failures[0]?.detail).toContain("cached-input");
  });
});

describe("parseUpstreamCost", () => {
  test("reads positive numeric fields and drops zero or missing ones", () => {
    expect(
      parseUpstreamCost({ cost: { input: 1, output: 0, cache_read: 0.1 } }),
    ).toEqual({ input: 1, output: undefined, cacheRead: 0.1 });
  });

  test("returns null without a cost object", () => {
    expect(parseUpstreamCost({})).toBeNull();
    expect(parseUpstreamCost(null)).toBeNull();
  });
});
