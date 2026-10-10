import { describe, expect, test } from "bun:test";

import { Temporal, todayFor } from "@stll/time";

import { getMonthWeekRows } from "./calendar-scroll.logic";
import { getMonthDays, getWeekDays } from "./calendar-utils";

// 00:30 on 1 April in Prague (CEST, UTC+2) is still 31 March in UTC.
const AT = Temporal.Instant.from("2026-03-31T22:30:00Z");
const PRAGUE_TODAY = todayFor("Europe/Prague", AT);
const MONDAY_FIRST = 1;
const WEEKEND = new Set([0, 6]);

const todayCells = (days: readonly { date: string; isToday: boolean }[]) =>
  days.filter((day) => day.isToday).map((day) => day.date);

describe("calendar today", () => {
  test("is the viewer's day, not the UTC day, just after local midnight", () => {
    expect(PRAGUE_TODAY.toString()).toBe("2026-04-01");
    expect(todayFor("UTC", AT).toString()).toBe("2026-03-31");
  });

  test("the month grid marks the viewer's day", () => {
    const days = getMonthDays({
      year: 2026,
      month: 3,
      firstWeekday: MONDAY_FIRST,
      weekend: WEEKEND,
      today: PRAGUE_TODAY,
    });

    expect(todayCells(days)).toEqual(["2026-04-01"]);
  });

  test("the week view marks the viewer's day", () => {
    const days = getWeekDays(
      Temporal.PlainDate.from("2026-03-30"),
      MONDAY_FIRST,
      WEEKEND,
      PRAGUE_TODAY,
    );

    expect(todayCells(days)).toEqual(["2026-04-01"]);
  });

  test("the continuous month view marks the viewer's day once", () => {
    const rows = getMonthWeekRows(
      "cs",
      Temporal.PlainDate.from("2026-02-01"),
      PRAGUE_TODAY,
    );

    expect(todayCells(rows.flatMap((row) => row.days))).toEqual(["2026-04-01"]);
  });
});
