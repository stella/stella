import { describe, expect, test } from "bun:test";

import {
  areStorableCalendarDates,
  isStorableCalendarDate,
} from "@/api/lib/tasks/task-dates";

describe("isStorableCalendarDate", () => {
  test.each(["2026-10-23", "2024-02-29", "0001-01-01", "9999-12-31"])(
    "accepts %s",
    (value) => {
      expect(isStorableCalendarDate(value)).toBe(true);
    },
  );

  test.each([
    "2026-02-30",
    "2026-04-31",
    "2025-02-29",
    "0000-01-01",
    "2026-1-5",
    "2026/10/23",
    "2026-10-23T00:00:00Z",
  ])("rejects %s", (value) => {
    expect(isStorableCalendarDate(value)).toBe(false);
  });
});

describe("areStorableCalendarDates", () => {
  test("skips absent and cleared dates", () => {
    expect(areStorableCalendarDates([undefined, null, "2026-10-23"])).toBe(
      true,
    );
  });

  test("rejects when any present date is not a calendar day", () => {
    expect(areStorableCalendarDates(["2026-10-23", "2026-02-30"])).toBe(false);
  });
});
