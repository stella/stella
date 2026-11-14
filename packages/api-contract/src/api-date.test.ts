import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { apiDateSchema, isApiDate } from "./api-date";

describe("API calendar date boundaries", () => {
  test("accepts exactly existing CE calendar days across month and leap-century boundaries", () => {
    // Include the 0..99 Date constructor trap and Gregorian century exceptions.
    for (const year of [
      0, 1, 4, 99, 100, 399, 400, 1600, 1700, 1900, 2000, 2024, 2026, 2028,
      9999,
    ]) {
      for (let month = 0; month <= 13; month += 1) {
        for (let day = 0; day <= 32; day += 1) {
          const value = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          // Independent oracle: JavaScript normalizes nonexistent days, so only
          // a round trip with unchanged components represents a real date.
          const normalized = new Date(0);
          normalized.setUTCFullYear(year, month - 1, day);
          const expected =
            year > 0 &&
            normalized.getUTCFullYear() === year &&
            normalized.getUTCMonth() === month - 1 &&
            normalized.getUTCDate() === day;
          expect(isApiDate(value)).toBe(expected);
          expect(v.is(apiDateSchema, value)).toBe(expected);
        }
      }
    }
  });

  test.each([
    "2026-2-01",
    "2026-02-1",
    "2026/02/01",
    "01/02/2026",
    "2026-02-01T00:00:00Z",
    "+010000-01-01",
    "-0001-01-01",
    " 2026-02-01",
    "2026-02-01\n",
    '"2026-02-01"',
    "",
  ])("rejects noncanonical calendar date %j", (value) => {
    expect(v.is(apiDateSchema, value)).toBe(false);
  });
});
