import { describe, expect, test } from "bun:test";

import type { ModelRate, ModelRateAmounts } from "@stll/ai-catalog";

import { parseUpstreamCost, validateRates } from "./model-catalog-rates";
import type { UpstreamCost } from "./model-catalog-rates";

const FIRST_PARTY = { openai: "openai", anthropic: "anthropic" } as const;
type FlatModelRate = Extract<ModelRate, { kind: "flat" }>;

// Factor 100_000 micro-units per upstream dollar, matching the live
// table's normalization.
const consistentAmounts = (
  input: number,
  output: number,
): ModelRateAmounts => ({
  inputPerMTok: input * 100_000,
  outputPerMTok: output * 100_000,
});

const consistentRate = (input: number, output: number): FlatModelRate => ({
  kind: "flat",
  ...consistentAmounts(input, output),
});

const cost = (
  input: number,
  output: number,
  cacheRead?: number,
  inputTokenTiers: UpstreamCost["inputTokenTiers"] = [],
): UpstreamCost => ({ input, output, cacheRead, inputTokenTiers });

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
          kind: "flat",
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

  test("accepts a matching long-context rate schedule", () => {
    const { failures } = validateRates({
      entries: [{ provider: "openai", modelId: "gpt-tiered" }],
      firstPartyProviders: FIRST_PARTY,
      costs: new Map([
        [
          "openai:gpt-tiered",
          cost(1, 4, undefined, [
            {
              inputTokenThreshold: 272_000,
              input: 2,
              output: 6,
              cacheRead: undefined,
            },
          ]),
        ],
      ]),
      rates: {
        "gpt-tiered": {
          kind: "input-token-tiered",
          inputTokenThreshold: 272_000,
          standard: consistentAmounts(1, 4),
          aboveThreshold: consistentAmounts(2, 6),
        },
      },
    });
    expect(failures).toEqual([]);
  });

  test("flags an upstream context tier represented by a flat rate", () => {
    const { failures } = validateRates({
      entries: [{ provider: "openai", modelId: "gpt-flat" }],
      firstPartyProviders: FIRST_PARTY,
      costs: new Map([
        [
          "openai:gpt-flat",
          cost(1, 4, undefined, [
            {
              inputTokenThreshold: 272_000,
              input: 2,
              output: 6,
              cacheRead: undefined,
            },
          ]),
        ],
      ]),
      rates: { "gpt-flat": consistentRate(1, 4) },
    });
    expect(failures[0]?.label).toBe("NO TIERED RATE");
  });

  test("flags a tier threshold that diverges from upstream", () => {
    const { failures } = validateRates({
      entries: [{ provider: "openai", modelId: "gpt-tiered" }],
      firstPartyProviders: FIRST_PARTY,
      costs: new Map([
        [
          "openai:gpt-tiered",
          cost(1, 4, undefined, [
            {
              inputTokenThreshold: 200_000,
              input: 2,
              output: 6,
              cacheRead: undefined,
            },
          ]),
        ],
      ]),
      rates: {
        "gpt-tiered": {
          kind: "input-token-tiered",
          inputTokenThreshold: 272_000,
          standard: consistentAmounts(1, 4),
          aboveThreshold: consistentAmounts(2, 6),
        },
      },
    });
    expect(failures[0]?.label).toBe("TIER DRIFT");
  });

  test("validates long-context amounts against upstream tier prices", () => {
    const { failures } = validateRates({
      entries: [
        { provider: "openai", modelId: "gpt-a" },
        { provider: "anthropic", modelId: "claude-b" },
        { provider: "openai", modelId: "gpt-tiered" },
      ],
      firstPartyProviders: FIRST_PARTY,
      costs: new Map([
        ["openai:gpt-a", cost(1, 4)],
        ["anthropic:claude-b", cost(3, 15)],
        [
          "openai:gpt-tiered",
          cost(1, 4, undefined, [
            {
              inputTokenThreshold: 272_000,
              input: 2,
              output: 6,
              cacheRead: undefined,
            },
          ]),
        ],
      ]),
      rates: {
        "gpt-a": consistentRate(1, 4),
        "claude-b": consistentRate(3, 15),
        "gpt-tiered": {
          kind: "input-token-tiered",
          inputTokenThreshold: 272_000,
          standard: consistentAmounts(1, 4),
          // Stale long-context input price: 3x upstream instead of 1x.
          aboveThreshold: consistentAmounts(6, 6),
        },
      },
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.entry.modelId).toBe("gpt-tiered");
    expect(failures[0]?.detail).toContain("tiered-input");
  });
});

describe("parseUpstreamCost", () => {
  test("reads positive numeric fields and drops zero or missing ones", () => {
    expect(
      parseUpstreamCost({ cost: { input: 1, output: 0, cache_read: 0.1 } }),
    ).toEqual({
      input: 1,
      output: undefined,
      cacheRead: 0.1,
      inputTokenTiers: [],
    });
  });

  test("reads context-price tiers and ignores unrelated tier kinds", () => {
    expect(
      parseUpstreamCost({
        cost: {
          input: 5,
          output: 30,
          tiers: [
            {
              input: 10,
              output: 45,
              cache_read: 1,
              tier: { type: "context", size: 272_000 },
            },
            { input: 1, output: 1, tier: { type: "region", size: 1 } },
          ],
        },
      }),
    ).toEqual({
      input: 5,
      output: 30,
      cacheRead: undefined,
      inputTokenTiers: [
        {
          inputTokenThreshold: 272_000,
          input: 10,
          output: 45,
          cacheRead: 1,
        },
      ],
    });
  });

  test("reads a size-only context tier when the optional type is absent", () => {
    const parsed = parseUpstreamCost({
      cost: {
        input: 5,
        output: 30,
        tiers: [
          {
            input: 10,
            output: 45,
            cache_read: 1,
            tier: { size: 272_000 },
          },
        ],
      },
    });

    expect(parsed).toEqual({
      input: 5,
      output: 30,
      cacheRead: undefined,
      inputTokenTiers: [
        {
          inputTokenThreshold: 272_000,
          input: 10,
          output: 45,
          cacheRead: 1,
        },
      ],
    });

    const { failures } = validateRates({
      entries: [{ provider: "openai", modelId: "gpt-tiered" }],
      firstPartyProviders: FIRST_PARTY,
      costs: new Map(parsed === null ? [] : [["openai:gpt-tiered", parsed]]),
      rates: {
        "gpt-tiered": {
          kind: "input-token-tiered",
          inputTokenThreshold: 272_000,
          standard: consistentAmounts(5, 30),
          aboveThreshold: {
            ...consistentAmounts(20, 45),
            cachedInputPerMTok: 100_000,
          },
        },
      },
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.label).toBe("RATE DRIFT");
    expect(failures[0]?.detail).toContain("tiered-input");
  });

  test("returns null without a cost object", () => {
    expect(parseUpstreamCost({})).toBeNull();
    expect(parseUpstreamCost(null)).toBeNull();
  });
});
