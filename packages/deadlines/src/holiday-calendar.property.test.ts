import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { Temporal } from "@stll/time";

import { createHolidayCalendar, HOLIDAY_COVERAGE } from "./holiday-calendar";
import type { DeadlineJurisdiction } from "./rules";

const jurisdictions = Object.keys(HOLIDAY_COVERAGE).filter(
  (key): key is DeadlineJurisdiction => Object.hasOwn(HOLIDAY_COVERAGE, key),
);

const jurisdictionYearArbitrary = fc
  .constantFrom(...jurisdictions)
  .chain((jurisdiction) => {
    const { firstYear, lastYear } = HOLIDAY_COVERAGE[jurisdiction];
    return fc
      .integer({ min: firstYear, max: lastYear })
      .map((year) => ({ jurisdiction, year }));
  });

const coveredJurisdictionYears = jurisdictions.flatMap((jurisdiction) => {
  const { firstYear, lastYear } = HOLIDAY_COVERAGE[jurisdiction];
  return Array.from({ length: lastYear - firstYear + 1 }, (_, offset) => ({
    jurisdiction,
    year: firstYear + offset,
  }));
});

const GENERATED_CASE_COUNT = 100;

test("provider Easter Sunday is a Sunday between March 22 and April 25", () => {
  assertProperty(
    "provider Easter Sunday is a Sunday between March 22 and April 25",
    fc.property(jurisdictionYearArbitrary, ({ jurisdiction, year }) => {
      const calendar = createHolidayCalendar();
      const holidays: Temporal.PlainDate[] = [];
      const end = Temporal.PlainDate.from({ year, month: 5, day: 1 });
      let date = Temporal.PlainDate.from({ year, month: 3, day: 1 });
      // Both covered jurisdictions have only Good Friday and Easter Monday
      // as public holidays in March and April; do not filter by weekday.
      while (Temporal.PlainDate.compare(date, end) < 0) {
        if (calendar.getPublicHoliday({ jurisdiction, date }).unwrap()) {
          holidays.push(date);
        }
        date = date.add({ days: 1 });
      }
      expect(holidays).toHaveLength(2);
      const goodFriday = holidays.at(0);
      const easterMonday = holidays.at(1);
      if (!goodFriday || !easterMonday) {
        return false;
      }
      const sundayFromFriday = goodFriday.add({ days: 2 });
      const sundayFromMonday = easterMonday.subtract({ days: 1 });
      expect(sundayFromFriday.equals(sundayFromMonday)).toBe(true);
      expect(sundayFromFriday.dayOfWeek).toBe(7);
      expect(
        Temporal.PlainDate.compare(sundayFromFriday, `${year}-03-22`),
      ).toBeGreaterThanOrEqual(0);
      expect(
        Temporal.PlainDate.compare(sundayFromFriday, `${year}-04-25`),
      ).toBeLessThanOrEqual(0);
      return true;
    }),
    {
      numRuns: coveredJurisdictionYears.length + GENERATED_CASE_COUNT,
      examples: coveredJurisdictionYears.map(
        (pair) => [pair] satisfies [typeof pair],
      ),
    },
  );
});
