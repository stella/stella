import { describe, expect, test } from "bun:test";

import { Temporal } from "@stll/time";

import {
  pendingCountByDay,
  shiftWeeks,
  weekOf,
  weekTotals,
} from "./my-week.logic";

describe("weekOf", () => {
  test("every day of a week resolves to the same Monday-to-Sunday week", () => {
    // Crosses a month and a year boundary, and a daylight-saving change.
    for (const start of ["2026-03-23", "2025-12-29", "2026-10-26"]) {
      const expected = weekOf(start);
      for (const date of expected.days) {
        expect(weekOf(date)).toEqual(expected);
      }
      expect(Temporal.PlainDate.from(expected.start).dayOfWeek).toBe(1);
      expect(Temporal.PlainDate.from(expected.end).dayOfWeek).toBe(7);
      expect(expected.days).toHaveLength(7);
    }
  });

  test("a Sunday belongs to the week that started six days earlier", () => {
    expect(weekOf("2026-01-04")).toMatchObject({
      start: "2025-12-29",
      end: "2026-01-04",
    });
  });

  test("moving by weeks keeps the weekday", () => {
    expect(shiftWeeks("2026-10-28", -1)).toBe("2026-10-21");
    expect(shiftWeeks("2026-12-30", 1)).toBe("2027-01-06");
  });
});

describe("week totals", () => {
  test("sum logged and billable minutes and keep each day's total", () => {
    const totals = weekTotals([
      { dateWorked: "2026-10-26", loggedMinutes: 90, billableMinutes: 60 },
      { dateWorked: "2026-10-28", loggedMinutes: 30, billableMinutes: 0 },
    ]);
    expect(totals.loggedMinutes).toBe(120);
    expect(totals.billableMinutes).toBe(60);
    expect(totals.byDay.get("2026-10-26")).toBe(90);
    expect(totals.byDay.get("2026-10-27")).toBeUndefined();
  });

  test("count pending suggestions across matters per day", () => {
    const counts = pendingCountByDay([
      {
        date: "2026-10-26",
        matters: [{ items: [1, 2] }, { items: [3] }],
      },
    ]);
    expect(counts.get("2026-10-26")).toBe(3);
    expect(counts.get("2026-10-27")).toBeUndefined();
  });
});
