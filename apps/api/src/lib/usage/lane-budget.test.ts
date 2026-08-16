import { describe, expect, test } from "bun:test";

import {
  laneCounterBucketStart,
  utcDayStart,
  utcIsoWeekStart,
} from "./lane-budget";

const dayStartIso = (instant: string) =>
  utcDayStart(new Date(instant)).toISOString();

const weekStartIso = (instant: string) =>
  utcIsoWeekStart(new Date(instant)).toISOString();

describe("utcDayStart", () => {
  test("truncates to the UTC midnight of the same UTC day", () => {
    expect(dayStartIso("2026-08-14T23:59:59.999Z")).toBe(
      "2026-08-14T00:00:00.000Z",
    );
  });

  test("keeps the UTC day for instants whose local date differs", () => {
    // Both instants are 2026-08-14 in UTC but a neighbouring date in west-
    // and east-of-UTC zones; a bucket that followed the runtime's time zone
    // would reset at a different hour per deployment.
    expect(dayStartIso("2026-08-14T00:30:00.000Z")).toBe(
      "2026-08-14T00:00:00.000Z",
    );
    expect(dayStartIso("2026-08-14T23:30:00.000Z")).toBe(
      "2026-08-14T00:00:00.000Z",
    );
  });
});

describe("utcIsoWeekStart", () => {
  test("maps a mid-week instant back to its Monday", () => {
    // 2026-08-14 is a Friday.
    expect(weekStartIso("2026-08-14T09:15:00.000Z")).toBe(
      "2026-08-10T00:00:00.000Z",
    );
  });

  test("maps a Sunday back six days, not forward one", () => {
    expect(weekStartIso("2026-08-16T23:59:59.999Z")).toBe(
      "2026-08-10T00:00:00.000Z",
    );
  });

  test("is the identity on Monday midnight and truncates later Mondays", () => {
    expect(weekStartIso("2026-08-10T00:00:00.000Z")).toBe(
      "2026-08-10T00:00:00.000Z",
    );
    expect(weekStartIso("2026-08-10T18:45:00.000Z")).toBe(
      "2026-08-10T00:00:00.000Z",
    );
  });

  test("crosses the year boundary into the previous December", () => {
    // 2027-01-01 is a Friday, so its ISO week opens on 2026-12-28.
    expect(weekStartIso("2027-01-01T12:00:00.000Z")).toBe(
      "2026-12-28T00:00:00.000Z",
    );
    expect(weekStartIso("2026-12-28T00:00:00.000Z")).toBe(
      "2026-12-28T00:00:00.000Z",
    );
  });
});

describe("laneCounterBucketStart", () => {
  test("dispatches each counter kind to its bucket function", () => {
    const asOf = new Date("2026-08-14T09:15:00.000Z");

    expect(laneCounterBucketStart("daily", asOf)).toEqual(utcDayStart(asOf));
    expect(laneCounterBucketStart("fallback_weekly", asOf)).toEqual(
      utcIsoWeekStart(asOf),
    );
    // The kinds must not collapse onto one bucket away from a Monday.
    expect(laneCounterBucketStart("daily", asOf)).not.toEqual(
      laneCounterBucketStart("fallback_weekly", asOf),
    );
  });
});
