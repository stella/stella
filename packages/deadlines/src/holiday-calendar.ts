import { Result } from "better-result";
import Holidays from "date-holidays";

import type { HolidayCalendar, PublicHoliday } from "./deadline-calendar";
import { DeadlineError } from "./deadline-error";
import type { DeadlineJurisdiction } from "./rules";

// These are verification bounds, not holiday overrides. Extend them only after
// checking the pinned provider against the official legislation; see README.
export const HOLIDAY_COVERAGE = {
  CZ: { firstYear: 2016, lastYear: 2026 },
  SK: { firstYear: 2019, lastYear: 2026 },
} as const satisfies Record<
  DeadlineJurisdiction,
  { firstYear: number; lastYear: number }
>;

const hasHolidayCoverage = (
  jurisdiction: string,
): jurisdiction is DeadlineJurisdiction =>
  Object.hasOwn(HOLIDAY_COVERAGE, jurisdiction);

export const createHolidayCalendar = (): HolidayCalendar => {
  // The coverage bounds cap this cache at 19 jurisdiction-years. Each instance
  // belongs to its caller; importing the module initializes no provider state.
  const years = new Map<string, Map<string, PublicHoliday>>();

  return {
    courtHolidays: { type: "unsupported" },
    getPublicHoliday: ({ jurisdiction, date }) => {
      if (!hasHolidayCoverage(jurisdiction)) {
        return Result.err(
          new DeadlineError({
            message: "The jurisdiction has no supported holiday calendar.",
            reason: "unsupported_jurisdiction",
            jurisdiction,
          }),
        );
      }
      const coverage = HOLIDAY_COVERAGE[jurisdiction];
      if (
        date.calendarId !== "iso8601" ||
        date.year < coverage.firstYear ||
        date.year > coverage.lastYear
      ) {
        return Result.err(
          new DeadlineError({
            message:
              "The date is outside the verified holiday calendar coverage.",
            reason: "unsupported_date",
            jurisdiction,
            date: date.toString(),
          }),
        );
      }

      const cacheKey = `${jurisdiction}:${date.year}`;
      const cached = years.get(cacheKey);
      if (cached) {
        return Result.ok(cached.get(date.toString()) ?? null);
      }

      const loaded = Result.try({
        try: () => {
          // Explicit year, zone and language keep results independent of the
          // machine clock, host timezone and preferred language.
          const provider = new Holidays(jurisdiction, {
            types: ["public"],
            timezone: "UTC",
            languages: "en",
          });
          const holidays = new Map<string, PublicHoliday>();
          for (const holiday of provider.getHolidays(date.year)) {
            if (holiday.type !== "public") {
              continue;
            }
            const isoDate = holiday.date.slice(0, 10);
            const previous = holidays.get(isoDate);
            holidays.set(isoDate, {
              names: previous
                ? previous.names.concat(holiday.name)
                : [holiday.name],
            });
          }
          return holidays;
        },
        catch: (cause) =>
          new DeadlineError({
            message: "The holiday provider could not classify the date.",
            reason: "calendar_failure",
            jurisdiction,
            date: date.toString(),
            cause,
          }),
      });
      if (loaded.isErr()) {
        return loaded;
      }
      years.set(cacheKey, loaded.value);
      return Result.ok(loaded.value.get(date.toString()) ?? null);
    },
  };
};
