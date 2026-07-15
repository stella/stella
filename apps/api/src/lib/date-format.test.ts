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

  test("formats ISO dates for human-readable field output", () => {
    expect(
      formatIsoDateForDisplay({
        isoDate: "2025-07-29",
      }),
    ).toBe("29 Jul 2025");
  });
});
