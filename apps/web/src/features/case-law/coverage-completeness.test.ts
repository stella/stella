import { describe, expect, test } from "bun:test";

import {
  caseLawCompletenessExceedsReported,
  caseLawCompletenessPercent,
} from "@/features/case-law/coverage-completeness";

describe("a completeness percentage never overstates the corpus", () => {
  test("a corpus short of the total rounds down, so 99.6 % prints 99", () => {
    expect(caseLawCompletenessPercent({ reported: 1000, stored: 996 })).toBe(
      99,
    );
  });

  test("the last missing decision in a million still keeps it off 100", () => {
    expect(
      caseLawCompletenessPercent({ reported: 1_000_000, stored: 999_999 }),
    ).toBe(99);
  });

  test("only a corpus holding the whole stated total reaches 100", () => {
    expect(caseLawCompletenessPercent({ reported: 1000, stored: 1000 })).toBe(
      100,
    );
  });

  test("holding more than the total caps at 100 and says so separately", () => {
    const counts = { reported: 1000, stored: 1040 };

    expect(caseLawCompletenessPercent(counts)).toBe(100);
    expect(caseLawCompletenessExceedsReported(counts)).toBe(true);
  });

  test("a corpus within the total is not an overshoot", () => {
    expect(
      caseLawCompletenessExceedsReported({ reported: 1000, stored: 1000 }),
    ).toBe(false);
  });

  test("an unmeasured source has no percentage, which is not a zero", () => {
    expect(caseLawCompletenessPercent({ reported: 0, stored: 0 })).toBeNull();
    expect(
      caseLawCompletenessExceedsReported({ reported: 0, stored: 12 }),
    ).toBe(false);
  });

  test("a measured source holding nothing is a real zero", () => {
    expect(caseLawCompletenessPercent({ reported: 1000, stored: 0 })).toBe(0);
  });
});
