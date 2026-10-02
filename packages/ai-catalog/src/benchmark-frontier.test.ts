import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  classifyBenchmarkModelOptions,
  classifyBenchmarkPoints,
  dominatesBenchmarkPoint,
  getParetoFrontier,
  getPremiumBenchmarkPointIds,
  getUniqueModelBenchmarkPoints,
  statisticallyDominatesBenchmarkPoint,
} from "./benchmark-frontier";
import type {
  BenchmarkModelOption,
  ModelBenchmarkPoint,
} from "./benchmark-frontier";
import {
  getModelBenchmarkMeasurements,
  getModelUnratedReason,
  getTypicalCallCostUsd,
} from "./benchmarks";
import { BYOK_MODEL_OPTIONS, TANSTACK_AI_PROVIDERS } from "./index";

const point = ({
  cost,
  id,
  lower,
  rating,
  upper,
}: {
  cost: number;
  id: string;
  lower?: number;
  rating: number;
  upper?: number;
}): ModelBenchmarkPoint => ({
  availability: "available",
  costPerTypicalCallUsd: cost,
  id,
  isDirectRoute: true,
  modelValue: `openai::${id}`,
  reasoningEffort: "high",
  rating,
  ratingLower: lower ?? rating - 5,
  ratingUpper: upper ?? rating + 5,
  sourceModelId: id,
});

describe("Pareto model frontier", () => {
  test("keeps every best point estimate while removing dominated models", () => {
    const cheap = point({ cost: 0.2, id: "cheap", rating: 1400 });
    const balanced = point({ cost: 0.5, id: "balanced", rating: 1450 });
    const strongest = point({ cost: 1.2, id: "strongest", rating: 1500 });
    const dominated = point({ cost: 0.8, id: "dominated", rating: 1440 });

    expect(getParetoFrontier([strongest, dominated, cheap, balanced])).toEqual([
      cheap,
      balanced,
      strongest,
    ]);
  });

  test("partitions every point into frontier, near frontier, or dominated", () => {
    assertProperty(
      "partitions every point into frontier, near frontier, or dominated",
      fc.property(
        fc.uniqueArray(
          fc.record({
            cost: fc.integer({ min: 1, max: 500 }),
            halfWidth: fc.integer({ min: 0, max: 20 }),
            id: fc.uuid(),
            rating: fc.integer({ min: 1200, max: 1500 }),
          }),
          { maxLength: 30, selector: ({ id }) => id },
        ),
        (values) => {
          const points = values.map(({ cost, halfWidth, id, rating }) =>
            point({
              cost,
              id,
              lower: rating - halfWidth,
              rating,
              upper: rating + halfWidth,
            }),
          );
          const classifications = classifyBenchmarkPoints(points);

          expect(classifications.size).toBe(points.length);
          for (const candidate of points) {
            const isDominatedOnEstimates = points.some((other) =>
              dominatesBenchmarkPoint(other, candidate),
            );
            const isStatisticallyDominated = points.some((other) =>
              statisticallyDominatesBenchmarkPoint(other, candidate),
            );
            switch (classifications.get(candidate.id)) {
              case "frontier":
                expect(isDominatedOnEstimates).toBe(false);
                break;
              case "dominated":
                expect(isDominatedOnEstimates).toBe(true);
                expect(isStatisticallyDominated).toBe(true);
                break;
              case "near_frontier":
                expect(isDominatedOnEstimates).toBe(true);
                expect(isStatisticallyDominated).toBe(false);
                break;
              case undefined:
                throw new Error(`unclassified point ${candidate.id}`);
            }
          }
        },
      ),
    );
  });

  test("keeps overlapping confidence intervals near the frontier", () => {
    const efficient = point({
      cost: 0.5,
      id: "efficient",
      lower: 1450,
      rating: 1460,
      upper: 1470,
    });
    const uncertain = point({
      cost: 0.8,
      id: "uncertain",
      lower: 1445,
      rating: 1455,
      upper: 1465,
    });

    expect(
      classifyBenchmarkPoints([efficient, uncertain]).get("uncertain"),
    ).toBe("near_frontier");
  });

  test("flags a point once a cheaper lower bound clears its upper bound", () => {
    const efficient = point({
      cost: 0.5,
      id: "efficient",
      lower: 1458,
      rating: 1460,
      upper: 1462,
    });
    const dominated = point({
      cost: 0.8,
      id: "dominated",
      lower: 1448,
      rating: 1450,
      upper: 1452,
    });

    expect(
      classifyBenchmarkPoints([efficient, dominated]).get("dominated"),
    ).toBe("dominated");
  });
});

describe("benchmark route identity", () => {
  test("keeps one point per Arena row, preferring the creator's own API", () => {
    const direct = point({ cost: 0.5, id: "direct", rating: 1450 });
    const routed = {
      ...direct,
      costPerTypicalCallUsd: 0.6,
      id: "routed",
      isDirectRoute: false,
    } satisfies ModelBenchmarkPoint;

    expect(getUniqueModelBenchmarkPoints([routed, direct])).toEqual([direct]);
  });

  test("keeps an available route over an unconfigured direct route", () => {
    const direct = {
      ...point({ cost: 0.5, id: "direct", rating: 1450 }),
      availability: "provider_unconfigured",
    } satisfies ModelBenchmarkPoint;
    const routed = {
      ...direct,
      availability: "available",
      id: "routed",
      isDirectRoute: false,
    } satisfies ModelBenchmarkPoint;

    expect(getUniqueModelBenchmarkPoints([direct, routed])).toEqual([routed]);
  });
});

describe("premium cost", () => {
  test("is independent of frontier membership", () => {
    const cheap = point({ cost: 1, id: "cheap", rating: 1400 });
    const middle = point({ cost: 1.1, id: "middle", rating: 1420 });
    const premium = point({ cost: 10, id: "premium", rating: 1500 });
    const points = [cheap, middle, premium];

    expect(getParetoFrontier(points)).toContain(premium);
    expect(getPremiumBenchmarkPointIds(points)).toEqual(new Set(["premium"]));
  });

  test("flags nothing for an empty set", () => {
    expect(getPremiumBenchmarkPointIds([]).size).toBe(0);
  });
});

describe("typical call cost", () => {
  test("prices 20k input and 2k output tokens at the standard list rate", () => {
    // gemini-3.8-flash lists USD 0.75 input and USD 3.75 output per 1M tokens.
    expect(getTypicalCallCostUsd("gemini-3.8-flash")).toBeCloseTo(0.0225, 10);
  });

  test("is unknown for an unrated model", () => {
    expect(getTypicalCallCostUsd("not-a-catalogued-model")).toBeNull();
  });
});

describe("unrated models", () => {
  test("every offered model has a measured variant or a reviewed reason, never both", () => {
    for (const provider of TANSTACK_AI_PROVIDERS) {
      for (const modelId of BYOK_MODEL_OPTIONS[provider]) {
        const measured = getModelBenchmarkMeasurements(modelId).length > 0;
        const reason = getModelUnratedReason(modelId);
        expect({ modelId, measured: measured || reason === null }).toEqual({
          modelId,
          measured: reason === null,
        });
      }
    }
  });

  test("marks models released after the snapshot as too new", () => {
    expect(getModelUnratedReason("gpt-6.1-sol")).toBe("too_new");
    expect(getModelUnratedReason("mistral-large-latest")).toBe(
      "floating_alias",
    );
    expect(getModelUnratedReason("gemini-3.8-flash")).toBeNull();
  });
});

describe("option trade-offs", () => {
  const option = ({
    cost,
    measurements,
    provider,
    value,
  }: {
    cost: number | null;
    measurements: BenchmarkModelOption["measurements"];
    provider: BenchmarkModelOption["provider"];
    value: string;
  }): BenchmarkModelOption => ({
    availability: "available",
    costPerTypicalCallUsd: cost,
    iconProvider: "openai",
    measurements,
    provider,
    value,
  });
  const measurement = (
    sourceModelId: string,
    reasoningEffort: "high" | "max" | null,
    rating: number,
  ) => ({
    rating,
    ratingLower: rating - 2,
    ratingUpper: rating + 2,
    reasoningEffort,
    sourceModelId,
  });

  test("reports dominated efforts, shared rows, and unmeasured routes", () => {
    const efficient = option({
      cost: 0.1,
      measurements: [measurement("efficient-high", "high", 1480)],
      provider: "openai",
      value: "openai::efficient",
    });
    const mixed = option({
      cost: 0.4,
      measurements: [
        measurement("mixed", null, 1400),
        measurement("mixed-max", "max", 1500),
      ],
      provider: "openai",
      value: "openai::mixed",
    });
    const routed = option({
      cost: 0.5,
      measurements: [measurement("mixed-max", "max", 1500)],
      provider: "openrouter",
      value: "openrouter::openai/mixed",
    });
    const unmeasured = option({
      cost: 0.2,
      measurements: [],
      provider: "openai",
      value: "openai::unmeasured",
    });

    const [classifiedEfficient, classifiedMixed, classifiedRouted, none] =
      classifyBenchmarkModelOptions([efficient, mixed, routed, unmeasured]);

    expect(classifiedEfficient?.tradeoff.type).toBe("pareto");
    expect(classifiedMixed?.tradeoff).toEqual({
      dominatedReasoningEfforts: [null],
      premiumReasoningEfforts: [],
      type: "pareto",
    });
    expect(classifiedRouted?.measurements.at(0)?.classification).toBe(
      "frontier",
    );
    expect(none?.tradeoff.type).toBe("unmeasured");
  });
});
