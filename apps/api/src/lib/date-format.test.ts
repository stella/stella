import { describe, expect, test } from "bun:test";

import {
  formatDateTimeInTimeZone,
  formatIsoDateForDisplay,
} from "@/api/lib/date-format";

describe("date format helpers", () => {
  test("formats a timezone-aware date/time for chat prompts", () => {
    expect(
      formatDateTimeInTimeZone({
        date: new Date("2025-07-29T14:05:00Z"),
        timezone: "Europe/Warsaw",
      }),
    ).toBe("Tuesday, July 29, 2025 at 16:05");
  });

  test("falls back to ISO when the timezone is invalid", () => {
    expect(
      formatDateTimeInTimeZone({
        date: new Date("2025-07-29T14:05:00Z"),
        timezone: "not/a-timezone",
      }),
    ).toBe("2025-07-29T14:05:00.000Z");
  });

  test.each([
    ["2025-07-29", "29 Jul 2025"],
    ["2011-12-30", "30 Dec 2011"],
    ["0099-01-01", "1 Jan 99"],
    ["2024-02-29", "29 Feb 2024"],
  ])(
    "formats calendar date %s without timezone conversion",
    (isoDate, expected) => {
      expect(formatIsoDateForDisplay({ isoDate })).toBe(expected);
    },
  );

  test.each(["2025-02-29", "2025-09-31", "not-a-date", ""])(
    "marks invalid calendar date %s without normalizing it",
    (isoDate) => {
      expect(formatIsoDateForDisplay({ isoDate })).toBe("Invalid Date");
    },
  );
});
