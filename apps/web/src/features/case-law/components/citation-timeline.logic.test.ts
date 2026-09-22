import { describe, expect, test } from "bun:test";

import {
  citationTimelineColumns,
  citationTimelinePeak,
  lastNegativeYear,
  peakTimelineColumn,
  stackColumnSegments,
  timelineTickYears,
  topCitingDecisions,
} from "@/features/case-law/components/citation-timeline.logic";

const counts = ({
  mixed = 0,
  negative = 0,
  neutral = 0,
  positive = 0,
  supportive = 0,
  unclassified = 0,
  year,
}: {
  mixed?: number;
  negative?: number;
  neutral?: number;
  positive?: number;
  supportive?: number;
  unclassified?: number;
  year: number;
}) => ({ mixed, negative, neutral, positive, supportive, unclassified, year });

describe("stackColumnSegments", () => {
  test("the stack never exceeds the column and every treatment stays visible", () => {
    // Six present treatments at 16px: independent rounding plus the 1px
    // floor would sum to 17 and push the top segment above the strip.
    const segments = stackColumnSegments({
      baseline: 16,
      columnHeight: 16,
      counts: counts({
        mixed: 3,
        negative: 3,
        neutral: 3,
        positive: 3,
        supportive: 3,
        unclassified: 13,
        year: 2020,
      }),
    });
    const stacked = segments.reduce((sum, part) => sum + part.height, 0);
    expect(stacked).toBeLessThanOrEqual(16);
    expect(segments).toHaveLength(6);
    for (const segment of segments) {
      expect(segment.height).toBeGreaterThanOrEqual(1);
      expect(segment.y).toBeGreaterThanOrEqual(0);
    }
    // Negative is stacked last, so it sits on top.
    expect(segments.at(-1)?.treatment).toBe("negative");
  });

  test("absent treatments draw nothing", () => {
    const segments = stackColumnSegments({
      baseline: 16,
      columnHeight: 16,
      counts: counts({ positive: 3, year: 2020 }),
    });
    expect(segments.map((part) => part.treatment)).toEqual(["positive"]);
    expect(segments.at(0)?.height).toBe(16);
  });

  test("a year with more treatments than pixels keeps every one of them", () => {
    // Six treatments scaled to a single pixel: the floor cannot be paid off
    // against a 1px column, so the stack settles at one pixel per treatment
    // rather than overrunning the height it was asked for. Six treatments is
    // the ceiling on that overshoot, and the baseline it stands on carries it.
    const segments = stackColumnSegments({
      baseline: 6,
      columnHeight: 1,
      counts: counts({
        mixed: 1,
        negative: 1,
        neutral: 1,
        positive: 1,
        supportive: 1,
        unclassified: 1,
        year: 2020,
      }),
    });
    const stacked = segments.reduce((sum, part) => sum + part.height, 0);
    expect(segments).toHaveLength(6);
    expect(stacked).toBe(6);
    for (const segment of segments) {
      expect(segment.height).toBe(1);
      expect(segment.y).toBeGreaterThanOrEqual(0);
    }
  });

  test("the column stands on the baseline it is given", () => {
    // The chart draws the same stack lower down its own plot than the strip.
    const segments = stackColumnSegments({
      baseline: 83,
      columnHeight: 20,
      counts: counts({ positive: 3, year: 2020 }),
    });
    expect(segments.at(0)).toEqual({
      height: 20,
      treatment: "positive",
      y: 63,
    });
  });
});

describe("citationTimelineColumns", () => {
  test("fills the silent years and drops what falls outside the span", () => {
    const columns = citationTimelineColumns({
      byYear: [
        counts({ positive: 2, year: 2019 }),
        counts({ negative: 1, year: 2022 }),
      ],
      fromYear: 2020,
      toYear: 2023,
    });
    expect(columns.map((column) => column.year)).toEqual([
      2020, 2021, 2022, 2023,
    ]);
    expect(columns.map((column) => column.total)).toEqual([0, 0, 1, 0]);
    expect(columns.at(0)?.counts).toBeUndefined();
  });
});

describe("citationTimelinePeak", () => {
  test("an uncited span still scales against one", () => {
    const columns = citationTimelineColumns({
      byYear: [],
      fromYear: 2020,
      toYear: 2021,
    });
    expect(citationTimelinePeak(columns)).toBe(1);
  });

  test("the busiest year sets the scale and carries the printed count", () => {
    const columns = citationTimelineColumns({
      byYear: [
        counts({ positive: 2, year: 2020 }),
        counts({ negative: 1, neutral: 4, year: 2021 }),
      ],
      fromYear: 2020,
      toYear: 2021,
    });
    expect(citationTimelinePeak(columns)).toBe(5);
    expect(peakTimelineColumn(columns)?.year).toBe(2021);
  });

  test("nothing is labelled when nothing is cited", () => {
    const columns = citationTimelineColumns({
      byYear: [],
      fromYear: 2020,
      toYear: 2021,
    });
    expect(peakTimelineColumn(columns)).toBeUndefined();
  });
});

describe("timelineTickYears", () => {
  test("both ends of the span are always labelled", () => {
    const years = [2018, 2019, 2020, 2021];
    const ticks = timelineTickYears({ maxTicks: 8, years });
    expect(ticks.at(0)).toBe(2018);
    expect(ticks.at(-1)).toBe(2021);
    expect(ticks).toEqual(years);
  });

  test("a long span is thinned to what fits, ends included", () => {
    const years = Array.from({ length: 60 }, (_, index) => 1966 + index);
    const ticks = timelineTickYears({ maxTicks: 8, years });
    expect(ticks.length).toBeLessThanOrEqual(8);
    expect(ticks.at(0)).toBe(1966);
    expect(ticks.at(-1)).toBe(2025);
    // Evenly spaced, and never two labels on top of each other.
    const gaps = ticks
      .slice(1)
      .map((year, index) => year - (ticks[index] ?? 0));
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(4);
    }
  });

  test("a one-year span labels that year once", () => {
    expect(timelineTickYears({ maxTicks: 8, years: [2024] })).toEqual([2024]);
  });

  test("an empty span labels nothing", () => {
    expect(timelineTickYears({ maxTicks: 8, years: [] })).toEqual([]);
  });
});

describe("topCitingDecisions", () => {
  const row = (
    id: string,
    citationAuthority: number,
    decisionDate: string | null,
  ) => ({ decision: { citationAuthority, decisionDate }, id });

  test("the most authoritative court first, the later decision on a tie", () => {
    const rows = [
      row("older-peer", 10, "2018-01-01"),
      row("weak", 2, "2024-01-01"),
      row("newer-peer", 10, "2021-06-01"),
    ];
    expect(topCitingDecisions(rows, 5).map((item) => item.id)).toEqual([
      "newer-peer",
      "older-peer",
      "weak",
    ]);
  });

  test("an undated decision falls to the end of its own tier", () => {
    const rows = [row("undated", 10, null), row("dated", 10, "2001-01-01")];
    expect(topCitingDecisions(rows, 5).map((item) => item.id)).toEqual([
      "dated",
      "undated",
    ]);
  });

  test("only the first few are shown, and the input is left alone", () => {
    const rows = [row("a", 1, "2020-01-01"), row("b", 9, "2020-01-01")];
    expect(topCitingDecisions(rows, 1).map((item) => item.id)).toEqual(["b"]);
    expect(rows.map((item) => item.id)).toEqual(["a", "b"]);
  });
});

describe("lastNegativeYear", () => {
  test("the most recent year with negative treatment, whatever the order", () => {
    expect(
      lastNegativeYear([
        counts({ negative: 1, year: 2021 }),
        counts({ negative: 2, year: 2019 }),
        counts({ positive: 3, year: 2023 }),
      ]),
    ).toBe(2021);
  });

  test("no negative treatment is no year", () => {
    expect(lastNegativeYear([counts({ positive: 3, year: 2023 })])).toBeNull();
  });
});
