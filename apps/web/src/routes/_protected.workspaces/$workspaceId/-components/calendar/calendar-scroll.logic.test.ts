import { describe, expect, test } from "bun:test";

import { Temporal } from "@stll/time";

import {
  getCenteredMonthWindowStart,
  getMonthAnchors,
  getMonthWeekRows,
  getMonthWindowStartContaining,
  getUTCMonthKey,
} from "./calendar-scroll.logic";

describe("scrollable calendar month window", () => {
  test("keeps an existing window when the target month is already rendered", () => {
    const windowStart = Temporal.PlainDate.from("2026-01-01");
    const targetMonth = Temporal.PlainDate.from("2026-05-01");

    expect(getMonthWindowStartContaining(windowStart, targetMonth)).toBe(
      windowStart,
    );
  });

  test("recenters around a distant target month before scrolling", () => {
    const targetMonth = Temporal.PlainDate.from("2027-11-01");
    const nextStart = getMonthWindowStartContaining(
      Temporal.PlainDate.from("2026-01-01"),
      targetMonth,
    );

    expect(getUTCMonthKey(nextStart)).toBe("2027-07");
    expect(getUTCMonthKey(getCenteredMonthWindowStart(targetMonth))).toBe(
      "2027-07",
    );
  });

  test("renders anchors for every month in the window", () => {
    const windowStart = Temporal.PlainDate.from("2026-01-01");
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
