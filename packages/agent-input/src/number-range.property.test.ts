import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { normalizeNumberInRange } from "./number";

const rangeArb = fc
  .tuple(
    fc.integer({ min: -1000, max: 1000 }),
    fc.integer({ min: 0, max: 1000 }),
  )
  .map(([minimum, width]) => ({ minimum, maximum: minimum + width }));

describe("bounded counts", () => {
  test("any number reads into the range", () => {
    fc.assert(
      fc.property(
        rangeArb,
        fc.double({ noNaN: true, noDefaultInfinity: true }),
        (range, value) => {
          const result = normalizeNumberInRange(value, range);
          expect(result.ok).toBe(true);
          const read = result.ok ? result.value : Number.NaN;
          expect(read).toBeGreaterThanOrEqual(range.minimum);
          expect(read).toBeLessThanOrEqual(range.maximum);
        },
      ),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("an integer in range is unchanged with nothing to report", () => {
    fc.assert(
      fc.property(rangeArb, fc.nat(), (range, offset) => {
        const value =
          range.minimum + (offset % (range.maximum - range.minimum + 1));
        expect(
          normalizeNumberInRange(value, { ...range, integer: true }),
        ).toEqual({ ok: true, value });
      }),
      propertyConfig({ numRuns: 300 }),
    );
  });
});
