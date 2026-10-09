import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { quantizeDistribution, quantizeFraction } from "./quantize-fractions";

test("fraction quantization preserves zero and rounds positive values to hundredths", () => {
  assertProperty(
    "fraction quantization preserves zero and rounds positive values to hundredths",
    fc.property(fc.integer({ min: 0, max: 10_000 }), (units) => {
      const fraction = units / 10_000;
      const result = quantizeFraction(fraction);
      if (fraction === 0) {
        expect(result).toBe(0);
      } else {
        expect(result).toBeGreaterThanOrEqual(0.01);
        expect(Math.abs(result * 100 - Math.round(result * 100))).toBeLessThan(
          1e-9,
        );
      }
    }),
  );
});

test("distribution quantization preserves support and returns a deterministic unit mass", () => {
  assertProperty(
    "distribution quantization preserves support and returns a deterministic unit mass",
    fc.property(
      fc
        .array(fc.integer({ min: 0, max: 10_000 }), { maxLength: 99 })
        .map((tail) => [1, ...tail]),
      (weights) => {
        const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
        const shares = weights.map((weight) => weight / totalWeight);
        const result = quantizeDistribution(shares);
        expect(
          result.reduce((sum, share) => sum + Math.round(share * 100), 0),
        ).toBe(100);
        expect(result.map((share) => share > 0)).toEqual(
          shares.map((share) => share > 0),
        );
        expect(result.filter((share) => share > 0).length).toBeLessThanOrEqual(
          100,
        );
        for (const share of result) {
          expect(Math.abs(share * 100 - Math.round(share * 100))).toBeLessThan(
            1e-9,
          );
          if (share > 0) {
            expect(share).toBeGreaterThanOrEqual(0.01);
          }
        }
        expect(quantizeDistribution(shares)).toEqual(result);
        expect(quantizeDistribution(result)).toEqual(result);
      },
    ),
  );
});

test("distribution rounding uses largest-share adjustments with index tie breaks", () => {
  expect(quantizeDistribution([0.334, 0.333, 0.333])).toEqual([
    0.34, 0.33, 0.33,
  ]);
  expect(quantizeDistribution([0.335, 0.335, 0.33])).toEqual([
    0.34, 0.33, 0.33,
  ]);
});

test("tiny positive shares retain support during integer apportionment", () => {
  assertProperty(
    "tiny positive shares retain support during integer apportionment",
    fc.property(fc.integer({ min: 1, max: 10_000 }), (units) => {
      const epsilon = units / 10_000_000_000_000;
      const result = quantizeDistribution([epsilon, 1 - epsilon]);
      expect(result).toEqual([0.01, 0.99]);
      expect(
        result.reduce((sum, share) => sum + Math.round(share * 100), 0),
      ).toBe(100);
      expect(quantizeDistribution(result)).toEqual(result);
    }),
  );
});

test("invalid fraction values and infeasible distributions are rejected", () => {
  for (const fraction of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => quantizeFraction(fraction)).toThrow(
      "Fractions must be finite numbers from zero through one",
    );
    expect(() => quantizeDistribution([fraction, 1])).toThrow(
      "Fractions must be finite numbers from zero through one",
    );
  }
  expect(() => quantizeDistribution([])).toThrow(
    "Distributions must contain at least one share",
  );
  expect(() => quantizeDistribution([0, 0])).toThrow(
    "Distributions must have positive mass",
  );
  expect(() => quantizeDistribution([0.4, 0.59])).toThrow(
    "Distribution mass must be within 1e-6 of one",
  );
  expect(() =>
    quantizeDistribution(Array.from({ length: 101 }, () => 1 / 101)),
  ).toThrow(
    "Distributions cannot preserve more than one hundred positive shares",
  );
});
