import { describe, expect, test } from "bun:test";

import { apportionSplitDurations } from "./split-durations.js";

describe("apportionSplitDurations", () => {
  // Each case satisfies the handler guard totalMinutes >= splits.length.
  const cases: { readonly total: number; readonly pct: number[] }[] = [
    { total: 10, pct: [91, 1, 1, 1, 1, 1, 1, 1, 1, 1] },
    { total: 5, pct: [90, 5, 5] },
    { total: 60, pct: [50, 30, 20] },
    { total: 3, pct: [34, 33, 33] },
    { total: 100, pct: [25, 25, 25, 25] },
    { total: 7, pct: [99, 1] },
    { total: 2, pct: [50, 50] },
  ];

  test("durations sum to the original total exactly", () => {
    for (const { total, pct } of cases) {
      const durations = apportionSplitDurations(total, pct);
      expect(durations.reduce((sum, d) => sum + d, 0)).toBe(total);
    }
  });

  test("every split gets at least one minute", () => {
    for (const { total, pct } of cases) {
      for (const duration of apportionSplitDurations(total, pct)) {
        expect(duration).toBeGreaterThanOrEqual(1);
      }
    }
  });

  test("never over-allocates with skewed small percentages", () => {
    // The pre-fix loop forced each rounded-to-zero split up to a full minute,
    // pushing the total above the original (10 / [91, 1x9] produced 18 minutes).
    const durations = apportionSplitDurations(
      10,
      [91, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    );
    expect(durations).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });

  test("apportions proportionally when minutes allow", () => {
    expect(apportionSplitDurations(60, [50, 30, 20])).toEqual([30, 18, 12]);
  });

  test("stays exact for a large dominant split, not distorted by a base minute", () => {
    expect(
      apportionSplitDurations(100, [91, 1, 1, 1, 1, 1, 1, 1, 1, 1]),
    ).toEqual([91, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });
});
