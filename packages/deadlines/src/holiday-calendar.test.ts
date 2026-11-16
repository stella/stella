import { expect, test } from "bun:test";

import { Temporal } from "@stll/time";

import { DeadlineError } from "./deadline-error";
import { createHolidayCalendar, HOLIDAY_COVERAGE } from "./holiday-calendar";
import type { DeadlineJurisdiction } from "./rules";

// Gregorian computus (Meeus/Jones/Butcher), independent of the holiday provider.
const easterSunday = (year: number) => {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const offset = h + l - 7 * m + 114;
  return Temporal.PlainDate.from({
    year,
    month: Math.floor(offset / 31),
    day: (offset % 31) + 1,
  });
};

// CZ: Act 245/2000 §§1–3; Good Friday added by 359/2015, effective
// 2015-12-21, so every Easter in the verified interval includes it.
// https://ppropo.mpsv.cz/zakon_245_2000
// https://www.psp.cz/sqw/sbirka.sqw?cz=359&r=2015
// SK: Act 241/1993 §§1–2, §4b. The 2024 text excludes September 1;
// the November 2025 text additionally excludes November 17. §4b removes
// May 8 and September 15 from days of rest only in 2026.
// https://static.slov-lex.sk/static/SK/ZZ/1993/241/20240101.print.html
// https://www.slov-lex.sk/ezbierky-fe/pravne-predpisy/SK/ZZ/1993/241/20251101
const statutoryHolidays = (
  jurisdiction: DeadlineJurisdiction,
  year: number,
) => {
  const fixed =
    jurisdiction === "CZ"
      ? [
          "01-01",
          "05-01",
          "05-08",
          "07-05",
          "07-06",
          "09-28",
          "10-28",
          "11-17",
          "12-24",
          "12-25",
          "12-26",
        ]
      : [
          "01-01",
          "01-06",
          "05-01",
          "07-05",
          "08-29",
          "11-01",
          "12-24",
          "12-25",
          "12-26",
        ];
  if (jurisdiction === "SK") {
    if (year < 2024) {
      fixed.push("09-01");
    }
    if (year < 2025) {
      fixed.push("11-17");
    }
    if (year !== 2026) {
      fixed.push("05-08", "09-15");
    }
  }
  const easter = easterSunday(year);
  expect(easter.dayOfWeek).toBe(7);
  expect(
    Temporal.PlainDate.compare(easter, `${year}-03-22`),
  ).toBeGreaterThanOrEqual(0);
  expect(
    Temporal.PlainDate.compare(easter, `${year}-04-25`),
  ).toBeLessThanOrEqual(0);
  return new Set([
    ...fixed.map((day) => `${year}-${day}`),
    easter.subtract({ days: 2 }).toString(),
    easter.add({ days: 1 }).toString(),
  ]);
};

for (const jurisdiction of ["CZ", "SK"] as const) {
  const { firstYear, lastYear } = HOLIDAY_COVERAGE[jurisdiction];
  for (let year = firstYear; year <= lastYear; year++) {
    test(`${jurisdiction} ${year} classifies every date according to statutory public holidays`, () => {
      const calendar = createHolidayCalendar();
      const expected = statutoryHolidays(jurisdiction, year);
      let date = Temporal.PlainDate.from({ year, month: 1, day: 1 });
      while (date.year === year) {
        const result = calendar.getPublicHoliday({ jurisdiction, date });
        expect(result.isOk(), date.toString()).toBe(true);
        if (result.isErr()) {
          throw result.error;
        }
        expect(result.value !== null, date.toString()).toBe(
          expected.has(date.toString()),
        );
        if (result.value) {
          expect(result.value.names.length).toBeGreaterThan(0);
          for (const name of result.value.names) {
            expect(name.trim().length).toBeGreaterThan(0);
          }
        }
        date = date.add({ days: 1 });
      }
    });
  }

  test(`${jurisdiction} rejects dates immediately outside verified coverage`, () => {
    const calendar = createHolidayCalendar();
    for (const isoDate of [`${firstYear - 1}-12-31`, `${lastYear + 1}-01-01`]) {
      const result = calendar.getPublicHoliday({
        jurisdiction,
        date: Temporal.PlainDate.from(isoDate),
      });
      expect(result.isErr()).toBe(true);
      if (result.isOk()) {
        continue;
      }
      expect(result.error).toBeInstanceOf(DeadlineError);
      expect(result.error.reason).toBe("unsupported_date");
      expect(result.error.date).toBe(isoDate);
      expect(result.error.jurisdiction).toBe(jurisdiction);
    }
  });
}
