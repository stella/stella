import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { backoffDelay } from "./backoff-delay";

const delays = fc.integer({ min: 0, max: 1_000_000 });
const attempts = fc.integer({ min: 0, max: 30 });
const samples = fc.double({ min: 0, max: 1, noNaN: true });

test("bounded backoff grows monotonically and saturates at its ceiling", () => {
  assertProperty(
    "bounded backoff grows monotonically and saturates at its ceiling",
    fc.property(delays, delays, attempts, (baseMs, maxMs, attempt) => {
      const delay = backoffDelay(attempt, { baseMs, maxMs });
      const next = backoffDelay(attempt + 1, { baseMs, maxMs });
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(maxMs);
      expect(next).toBeGreaterThanOrEqual(delay);
      if (delay === maxMs) {
        expect(next).toBe(maxMs);
      }
    }),
  );
});

test("full jitter stays within the capped range and preserves its endpoints", () => {
  assertProperty(
    "full jitter stays within the capped range and preserves its endpoints",
    fc.property(
      delays,
      delays,
      attempts,
      samples,
      (baseMs, maxMs, attempt, random) => {
        const ceiling = backoffDelay(attempt, { baseMs, maxMs });
        const jitter = { type: "full", random } as const;
        const delay = backoffDelay(attempt, { baseMs, maxMs, jitter });
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(ceiling);
        expect(
          backoffDelay(attempt, {
            baseMs,
            maxMs,
            jitter: { type: "full", random: 0 },
          }),
        ).toBe(0);
        expect(
          backoffDelay(attempt, {
            baseMs,
            maxMs,
            jitter: { type: "full", random: 1 },
          }),
        ).toBe(ceiling);
      },
    ),
  );
});

test("jitter policies preserve cap order, floors and multiplicative bounds", () => {
  expect(
    backoffDelay(4, {
      baseMs: 100,
      maxMs: 1000,
      jitter: { type: "full", random: 0.5 },
    }),
  ).toBe(500);
  expect(
    backoffDelay(4, {
      baseMs: 100,
      maxMs: 1000,
      jitter: { type: "additive", random: 0.5, rangeMs: 100 },
    }),
  ).toBe(1000);
  expect(
    backoffDelay(0, {
      baseMs: 100,
      jitter: {
        type: "additive",
        random: 0.555,
        rangeMs: 100,
        rounding: "floor",
      },
    }),
  ).toBe(155);
  expect(
    backoffDelay(0, {
      baseMs: 1000,
      jitter: { type: "full", random: 0.5555, minMs: 100, rounding: "floor" },
    }),
  ).toBe(599);
  expect(
    backoffDelay(2, {
      baseMs: 250,
      jitter: {
        type: "multiplicative",
        random: 0,
        minFactor: 0.5,
        maxFactor: 1.5,
      },
    }),
  ).toBe(500);
  expect(
    backoffDelay(2, {
      baseMs: 250,
      jitter: {
        type: "multiplicative",
        random: 1,
        minFactor: 0.5,
        maxFactor: 1.5,
      },
    }),
  ).toBe(1500);
});

test("custom factors and zero bases keep their delay semantics", () => {
  expect(backoffDelay(2, { baseMs: 100, factor: 3 })).toBe(900);
  expect(backoffDelay(2, { baseMs: 0 })).toBe(0);
  expect(backoffDelay(-1, { baseMs: 100 })).toBe(50);
});

// Math.random samples have at most 53 random fraction bits. Multiplying by a
// bounded power of two changes only the exponent, so the S3 policy retains
// identical IEEE-754 results when its scale is computed before its sample.
test("power-of-two full jitter preserves writer delays bit for bit", () => {
  assertProperty(
    "power-of-two full jitter preserves writer delays bit for bit",
    fc.property(
      fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
      fc.integer({ min: 0, max: 3 }),
      (bits, attempt) => {
        const random = bits / 9_007_199_254_740_992;
        expect(
          backoffDelay(attempt, {
            baseMs: 100,
            jitter: { type: "full", random },
          }),
        ).toBe(random * 100 * 2 ** attempt);
      },
    ),
  );
});
