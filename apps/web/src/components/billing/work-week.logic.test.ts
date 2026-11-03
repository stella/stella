import { describe, expect, test } from "bun:test";

import { Temporal } from "@stll/time";

import { shiftWeeks, weekOf } from "./work-week.logic";

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
