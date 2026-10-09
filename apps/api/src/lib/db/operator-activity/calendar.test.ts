import { describe, expect, test } from "bun:test";

import { buildActivityWindows } from "./calendar";

describe("operator activity Prague calendar windows", () => {
  test("completed weeks retain the spring 167-hour and autumn 169-hour spans", () => {
    for (const { now, weekStart, hours } of [
      { now: "2026-03-30T10:00:00Z", weekStart: "2026-03-23", hours: 167 },
      { now: "2026-10-26T10:00:00Z", weekStart: "2026-10-19", hours: 169 },
    ]) {
      const week = buildActivityWindows(Date.parse(now)).weeks.find(
        (candidate) => candidate.weekStart === weekStart,
      );
      expect(week).toBeDefined();
      if (week === undefined) {
        return;
      }
      expect(
        (Date.parse(week.until) - Date.parse(week.since)) / 3_600_000,
      ).toBe(hours);
      expect(week.partial).toBe(false);
    }
  });

  test("returns eight oldest-first Monday weeks across the year with a preceding baseline", () => {
    const windows = buildActivityWindows(Date.parse("2026-01-01T12:00:00Z"));
    expect(windows.weeks.map(({ weekStart }) => weekStart)).toEqual([
      "2025-11-10",
      "2025-11-17",
      "2025-11-24",
      "2025-12-01",
      "2025-12-08",
      "2025-12-15",
      "2025-12-22",
      "2025-12-29",
    ]);
    expect(windows.previousWeekSince).toBe("2025-11-02T23:00:00Z");
    expect(windows.weeks.map(({ partial }) => partial)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  test("caps the current week at an exact Prague Monday without a future bucket", () => {
    const now = Date.parse("2026-10-04T22:00:00Z");
    const windows = buildActivityWindows(now);
    expect(windows.generatedAt).toBe("2026-10-04T22:00:00Z");
    expect(windows.weeks.at(-1)).toEqual({
      weekStart: "2026-10-05",
      since: "2026-10-04T22:00:00Z",
      until: "2026-10-04T22:00:00Z",
      partial: true,
    });
    for (const week of windows.weeks) {
      expect(Date.parse(week.since)).toBeLessThanOrEqual(
        Date.parse(week.until),
      );
      expect(Date.parse(week.until)).toBeLessThanOrEqual(now);
    }
    expect(windows.weeks.length).toBe(8);
  });

  test("same-point comparison preserves Prague local clock through both DST transitions", () => {
    for (const { now, since, until } of [
      {
        now: "2026-03-29T10:30:00Z",
        since: "2026-03-15T23:00:00Z",
        until: "2026-03-22T11:30:00Z",
      },
      {
        now: "2026-10-25T11:30:00Z",
        since: "2026-10-11T22:00:00Z",
        until: "2026-10-18T10:30:00Z",
      },
    ]) {
      expect(buildActivityWindows(Date.parse(now)).samePointLastWeek).toEqual({
        since,
        until,
      });
    }
  });
});
