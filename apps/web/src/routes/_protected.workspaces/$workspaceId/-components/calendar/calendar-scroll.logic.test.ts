import { describe, expect, test } from "bun:test";

import {
  getCenteredMonthWindowStart,
  getMonthAnchors,
  getMonthWeekRows,
  getMonthWindowStartContaining,
  getUTCMonthKey,
} from "./calendar-scroll.logic";

describe("scrollable calendar month window", () => {
  test("keeps an existing window when the target month is already rendered", () => {
    const windowStart = new Date(Date.UTC(2026, 0, 1));
    const targetMonth = new Date(Date.UTC(2026, 4, 1));

    expect(getMonthWindowStartContaining(windowStart, targetMonth)).toBe(
      windowStart,
    );
  });

  test("recenters around a distant target month before scrolling", () => {
    const targetMonth = new Date(Date.UTC(2027, 10, 1));
    const nextStart = getMonthWindowStartContaining(
      new Date(Date.UTC(2026, 0, 1)),
      targetMonth,
    );

    expect(getUTCMonthKey(nextStart)).toBe("2027-07");
    expect(getUTCMonthKey(getCenteredMonthWindowStart(targetMonth))).toBe(
      "2027-07",
    );
  });

  test("renders anchors for every month in the window", () => {
    const windowStart = new Date(Date.UTC(2026, 0, 1));
    const anchors = getMonthAnchors("en", windowStart);
    const rows = getMonthWeekRows("en", windowStart);

    expect(anchors.map((anchor) => anchor.key)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
    ]);
    expect(
      rows.flatMap((row) => row.anchors).map((anchor) => anchor.key),
    ).toEqual(anchors.map((anchor) => anchor.key));
  });
});
