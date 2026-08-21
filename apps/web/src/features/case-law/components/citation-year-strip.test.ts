import { describe, expect, test } from "bun:test";

import { stackColumnSegments } from "@/features/case-law/components/citation-year-strip";

describe("stackColumnSegments", () => {
  test("the stack never exceeds the column and every treatment stays visible", () => {
    // Five present treatments at 16px: independent rounding plus the 1px
    // floor would sum to 18 and push the top segment above the strip.
    const segments = stackColumnSegments({
      columnHeight: 16,
      counts: {
        negative: 5,
        neutral: 5,
        positive: 5,
        supportive: 5,
        unclassified: 12,
        year: 2020,
      },
    });
    const stacked = segments.reduce((sum, part) => sum + part.height, 0);
    expect(stacked).toBeLessThanOrEqual(16);
    expect(segments).toHaveLength(5);
    for (const segment of segments) {
      expect(segment.height).toBeGreaterThanOrEqual(1);
      expect(segment.y).toBeGreaterThanOrEqual(0);
    }
    // Negative is stacked last, so it sits on top.
    expect(segments.at(-1)?.treatment).toBe("negative");
  });

  test("absent treatments draw nothing", () => {
    const segments = stackColumnSegments({
      columnHeight: 16,
      counts: {
        negative: 0,
        neutral: 0,
        positive: 3,
        supportive: 0,
        unclassified: 0,
        year: 2020,
      },
    });
    expect(segments.map((part) => part.treatment)).toEqual(["positive"]);
    expect(segments.at(0)?.height).toBe(16);
  });
});
