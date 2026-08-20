import { describe, expect, test } from "bun:test";

import {
  assertConsecutiveCalendarDates,
  getResourceCalendarPlacement,
  layoutResourceCalendarEntries,
  nextCalendarDate,
} from "./resource-calendar.logic";

describe("resource calendar placement", () => {
  const visibleRange = {
    endDateExclusive: "2026-08-08",
    startDate: "2026-08-01",
  };

  test("clips half-open entries to the visible columns", () => {
    expect(
      getResourceCalendarPlacement({
        entry: {
          endDateExclusive: "2026-08-04",
          startDate: "2026-07-30",
        },
        visibleRange,
      }),
    ).toEqual({ columnStart: 2, span: 3 });
    expect(
      getResourceCalendarPlacement({
        entry: {
          endDateExclusive: "2026-08-10",
          startDate: "2026-08-06",
        },
        visibleRange,
      }),
    ).toEqual({ columnStart: 7, span: 2 });
  });

  test("does not place adjacent or disjoint entries", () => {
    expect(
      getResourceCalendarPlacement({
        entry: {
          endDateExclusive: visibleRange.startDate,
          startDate: "2026-07-30",
        },
        visibleRange,
      }),
    ).toBeNull();
    expect(
      getResourceCalendarPlacement({
        entry: {
          endDateExclusive: "2026-08-10",
          startDate: visibleRange.endDateExclusive,
        },
        visibleRange,
      }),
    ).toBeNull();
  });

  test("rejects empty ranges and nonconsecutive columns", () => {
    expect(() =>
      getResourceCalendarPlacement({
        entry: {
          endDateExclusive: "2026-08-02",
          startDate: "2026-08-02",
        },
        visibleRange,
      }),
    ).toThrow("Calendar date ranges must be non-empty and half-open");
    expect(() =>
      assertConsecutiveCalendarDates(["2026-08-01", "2026-08-03"]),
    ).toThrow(
      "Resource calendar date columns must be consecutive normalized dates",
    );
    expect(() => assertConsecutiveCalendarDates(["2026-02-30"])).toThrow(
      "Resource calendar date columns must be consecutive normalized dates",
    );
  });

  test("keeps leap-day and year boundaries consecutive in UTC", () => {
    expect(() =>
      assertConsecutiveCalendarDates([
        "2024-02-28",
        "2024-02-29",
        "2024-03-01",
      ]),
    ).not.toThrow();
    expect(() =>
      assertConsecutiveCalendarDates(["2026-12-31", "2027-01-01"]),
    ).not.toThrow();
  });

  test("rejects a date whose following day exceeds the normalized range", () => {
    expect(() => nextCalendarDate("9999-12-31")).toThrow(
      "Calendar dates must have a following normalized YYYY-MM-DD value",
    );
  });

  test("puts overlapping entries in separate lanes and reuses adjacent lanes", () => {
    const entries = [
      {
        endDateExclusive: "2026-08-04",
        id: "first",
        startDate: "2026-08-01",
      },
      {
        endDateExclusive: "2026-08-03",
        id: "overlap",
        startDate: "2026-08-02",
      },
      {
        endDateExclusive: "2026-08-05",
        id: "adjacent",
        startDate: "2026-08-04",
      },
    ] as const;
    const layout = layoutResourceCalendarEntries(entries, visibleRange);

    expect(layout.rowCount).toBe(2);
    expect(layout.placements).toEqual([
      { columnStart: 2, entryId: "first", rowStart: 1, span: 3 },
      { columnStart: 3, entryId: "overlap", rowStart: 2, span: 1 },
      { columnStart: 5, entryId: "adjacent", rowStart: 1, span: 1 },
    ]);
    expect(
      layoutResourceCalendarEntries(entries.toReversed(), visibleRange),
    ).toEqual(layout);
  });
});
