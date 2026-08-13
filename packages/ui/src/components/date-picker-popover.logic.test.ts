import { describe, expect, test } from "bun:test";

import {
  millisecondsUntilNextUtcDate,
  utcDateFromTimestamp,
} from "./date-picker-popover.logic";

describe("date picker clock", () => {
  test("derives the UTC date on both sides of midnight", () => {
    expect(utcDateFromTimestamp(Date.UTC(2026, 7, 13, 23, 59, 59, 999))).toBe(
      "2026-08-13",
    );
    expect(utcDateFromTimestamp(Date.UTC(2026, 7, 14))).toBe("2026-08-14");
  });

  test("schedules refresh just after the next UTC date boundary", () => {
    expect(
      millisecondsUntilNextUtcDate(Date.UTC(2026, 7, 13, 23, 59, 59, 900)),
    ).toBe(150);
    expect(millisecondsUntilNextUtcDate(Date.UTC(2026, 7, 13, 12))).toBe(
      43_200_050,
    );
  });
});
