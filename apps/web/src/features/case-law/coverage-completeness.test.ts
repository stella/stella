/* oxlint-disable require-contract-domains/require-contract-domains -- Generator bounds size the property's counts, not an API limit. */
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { caseLawCompletenessPercent } from "@/features/case-law/coverage-completeness";

const unreconciled = { knownMissing: null } as const;

describe("a completeness percentage never overstates the corpus", () => {
  test("a corpus short of the total rounds down, so 99.6 % prints 99", () => {
    expect(
      caseLawCompletenessPercent({
        reported: 1000,
        stored: 996,
        ...unreconciled,
      }),
    ).toBe(99);
  });

  test("the last missing decision in a million still keeps it off 100", () => {
    expect(
      caseLawCompletenessPercent({
        reported: 1_000_000,
        stored: 999_999,
        ...unreconciled,
      }),
    ).toBe(99);
  });

  test("only a corpus holding the whole stated total reaches 100", () => {
    expect(
      caseLawCompletenessPercent({
        reported: 1000,
        stored: 1000,
        ...unreconciled,
      }),
    ).toBe(100);
    expect(
      caseLawCompletenessPercent({
        reported: 1000,
        stored: 1000,
        knownMissing: 0,
      }),
    ).toBe(100);
  });

  test("holding more than the total caps at 100", () => {
    expect(
      caseLawCompletenessPercent({
        reported: 1000,
        stored: 1040,
        ...unreconciled,
      }),
    ).toBe(100);
  });

  test("a count past the total with decisions known missing is not complete", () => {
    // The corpus holds rows the total no longer lists, and the source's own
    // reconciliation found listed decisions missing.
    expect(
      caseLawCompletenessPercent({
        reported: 554_000,
        stored: 554_614,
        knownMissing: 2729,
      }),
    ).toBe(99);
    expect(
      caseLawCompletenessPercent({
        reported: 1000,
        stored: 1040,
        knownMissing: 300,
      }),
    ).toBe(70);
  });

  test("property: any known missing decision keeps the figure off 100", () => {
    assertProperty(
      "any known missing decision keeps the figure off 100",
      fc.property(
        fc.integer({ min: 1, max: 10_000_000 }),
        fc.integer({ min: 0, max: 20_000_000 }),
        fc.integer({ min: 1, max: 10_000_000 }),
        (reported, stored, knownMissing) => {
          const percent = caseLawCompletenessPercent({
            reported,
            stored,
            knownMissing,
          });
          expect(percent).not.toBeNull();
          expect(percent ?? 100).toBeLessThan(100);
          expect(percent ?? -1).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });

  test("an unmeasured source has no percentage, which is not a zero", () => {
    expect(
      caseLawCompletenessPercent({ reported: 0, stored: 0, ...unreconciled }),
    ).toBeNull();
  });

  test("a measured source holding nothing is a real zero", () => {
    expect(
      caseLawCompletenessPercent({
        reported: 1000,
        stored: 0,
        ...unreconciled,
      }),
    ).toBe(0);
  });
});
