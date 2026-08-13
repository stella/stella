import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  localDateFromTimestamp,
  millisecondsUntilNextLocalDate,
  resolveCalendarViewMonth,
} from "./date-picker-popover.logic";

describe("date picker clock", () => {
  test("does not remount picker state when ambient values change", () => {
    const source = readFileSync(
      new URL("date-picker-popover.tsx", import.meta.url),
      "utf-8",
    );
    expect(source).not.toMatch(
      /<DatePickerPopoverContent\b(?:(?!\/>)[\s\S])*\bkey=/u,
    );
    expect(source).toContain(
      "<DatePickerPopoverContent {...props} locale={locale} today={today} />",
    );
  });

  test("derives the browser-local date on both sides of midnight", () => {
    expect(
      localDateFromTimestamp(new Date(2026, 7, 13, 23, 59, 59, 999).getTime()),
    ).toBe("2026-08-13");
    expect(localDateFromTimestamp(new Date(2026, 7, 14).getTime())).toBe(
      "2026-08-14",
    );
  });

  test("schedules refresh just after the next local date boundary", () => {
    expect(
      millisecondsUntilNextLocalDate(
        new Date(2026, 7, 13, 23, 59, 59, 900).getTime(),
      ),
    ).toBe(150);

    const midday = new Date(2026, 7, 13, 12).getTime();
    const nextMidnight = new Date(2026, 7, 14).getTime();
    expect(millisecondsUntilNextLocalDate(midday)).toBe(
      nextMidnight - midday + 50,
    );
  });

  test("follows today through hydration until the user navigates", () => {
    expect(
      resolveCalendarViewMonth({
        override: null,
        today: "1970-01-01",
        value: "",
      }),
    ).toEqual({ month: 0, year: 1970 });
    expect(
      resolveCalendarViewMonth({
        override: null,
        today: "2026-08-13",
        value: "",
      }),
    ).toEqual({ month: 7, year: 2026 });
  });

  test("preserves an explicitly navigated month across local midnight", () => {
    const override = { month: 2, year: 2030 };

    expect(
      resolveCalendarViewMonth({
        override,
        today: "2026-08-31",
        value: "",
      }),
    ).toEqual(override);
    expect(
      resolveCalendarViewMonth({
        override,
        today: "2026-09-01",
        value: "",
      }),
    ).toEqual(override);
  });
});
