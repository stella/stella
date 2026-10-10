import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  formatDateTimeValue,
  getHourOptions,
  getMinuteOptions,
  getTimeFieldNames,
  joinPickerTime,
  localDateFromTimestamp,
  millisecondsUntilNextLocalDate,
  parseDateTimeValue,
  resolveCalendarViewMonth,
  shiftCalendarDate,
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
    expect(source).toMatch(
      /<DatePickerPopoverContent\b[\s\S]*?\blocale=\{locale\}[\s\S]*?\btoday=\{today\}/u,
    );
    expect(source).toContain('globalThis.addEventListener("focus"');
    expect(source).toContain('globalThis.removeEventListener("focus"');
    expect(
      source.match(/globalThis\.addEventListener\("focus"/gu),
    ).toHaveLength(1);
    expect(source).toContain("if (localDateListeners.size === 1)");
    expect(source).toContain("if (localDateListeners.size === 0)");
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

  test("constrains keyboard month navigation to the target month", () => {
    expect(shiftCalendarDate("2026-01-31", { months: 1 })).toBe("2026-02-28");
    expect(shiftCalendarDate("2024-02-29", { years: 1 })).toBe("2025-02-28");
  });
});

describe("date-time values", () => {
  test("reads a wall-clock value at minute precision", () => {
    expect(parseDateTimeValue("2026-03-05T14:30")).toEqual({
      date: "2026-03-05",
      time: "14:30",
    });
    expect(parseDateTimeValue("2026-03-05T14:30:59.999")).toEqual({
      date: "2026-03-05",
      time: "14:30",
    });
    expect(parseDateTimeValue("2026-03-05")).toEqual({
      date: "2026-03-05",
      time: "00:00",
    });
    expect(parseDateTimeValue(null)).toBeNull();
    expect(parseDateTimeValue("")).toBeNull();
  });

  test("rejects an instant instead of guessing its time zone", () => {
    expect(() => parseDateTimeValue("2026-03-05T14:30:00Z")).toThrow(
      RangeError,
    );
  });

  test("a written value reads back unchanged", () => {
    for (const value of [
      "2026-03-05T14:30",
      "2024-02-29T00:00",
      "1999-12-31T23:59",
    ]) {
      const parsed = parseDateTimeValue(value);
      expect(parsed && formatDateTimeValue(parsed)).toBe(value);
    }
  });

  test("every hour and minute choice writes back a valid time", () => {
    const hours = getHourOptions("en-US");
    const minutes = getMinuteOptions("en-US");

    expect(hours.map(({ value }) => value)).toEqual(
      Array.from({ length: 24 }, (_, hour) => hour),
    );
    expect(minutes.map(({ value }) => value)).toEqual(
      Array.from({ length: 60 }, (_, minute) => minute),
    );
    for (const { value: hour } of hours) {
      for (const { value: minute } of minutes) {
        const time = joinPickerTime({ hour, minute });
        expect(parseDateTimeValue(`2026-03-05T${time}`)?.time).toBe(time);
      }
    }
  });
});

describe("time choices follow the locale", () => {
  test("hours use the locale's clock", () => {
    const english = getHourOptions("en-US");
    const czech = getHourOptions("cs");

    expect(english.at(14)?.label).toMatch(/^2\sPM$/u);
    expect(english.at(0)?.label).toMatch(/^12\sAM$/u);
    expect(czech.at(14)?.label).toBe("14");
    expect(new Set(english.map(({ label }) => label)).size).toBe(24);
    expect(new Set(czech.map(({ label }) => label)).size).toBe(24);
  });

  test("minutes keep two digits in the locale's numbering system", () => {
    expect(getMinuteOptions("en-US").at(5)?.label).toBe("05");
    expect(getMinuteOptions("ar-EG").at(5)?.label).toBe("٠٥");
  });

  test("field names come from the locale", () => {
    expect(getTimeFieldNames("en-US")).toEqual({
      hour: "Hour",
      minute: "Minute",
    });
    expect(getTimeFieldNames("cs").hour).not.toBe("Hour");
  });
});
