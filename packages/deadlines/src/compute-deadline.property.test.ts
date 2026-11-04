import { Result } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { Temporal } from "@stll/time";

import {
  computeDeadline,
  createHolidayCalendar,
  DEADLINE_UNIT,
  DeadlineError,
  type DeadlineJurisdiction,
  type DeadlineUnit,
  HOLIDAY_COVERAGE,
  type HolidayCalendar,
} from "./compute-deadline";
import { DEADLINE_RULES } from "./rules";

const jurisdictions = Object.keys(HOLIDAY_COVERAGE).filter(
  (jurisdiction): jurisdiction is DeadlineJurisdiction =>
    Object.hasOwn(HOLIDAY_COVERAGE, jurisdiction),
);

const triggerArbitrary = fc
  .record({
    year: fc.integer({
      min: Math.max(
        ...Object.values(HOLIDAY_COVERAGE).map(({ firstYear }) => firstYear),
      ),
      max:
        Math.min(
          ...Object.values(HOLIDAY_COVERAGE).map(({ lastYear }) => lastYear),
        ) - 1,
    }),
    month: fc.integer({ min: 1, max: 12 }),
  })
  .chain(({ year, month }) => {
    const start = Temporal.PlainDate.from({ year, month, day: 1 });
    return fc
      .integer({ min: 1, max: start.daysInMonth })
      .map((day) => start.with({ day }));
  });

const safeNominalEnd = (jurisdiction: DeadlineJurisdiction) =>
  Temporal.PlainDate.from({
    year: HOLIDAY_COVERAGE[jurisdiction].lastYear,
    month: 12,
    day: 31,
  }).subtract({ days: DEADLINE_RULES[jurisdiction].limits.maxShiftDays });

const deadlineCaseArbitrary = fc
  .constantFrom(...jurisdictions)
  .chain((jurisdiction) => {
    const first = Temporal.PlainDate.from({
      year: HOLIDAY_COVERAGE[jurisdiction].firstYear,
      month: 1,
      day: 1,
    });
    // Leave room for a positive year period and for the complete adjustment.
    const last = safeNominalEnd(jurisdiction).subtract({ years: 1 });
    return fc
      .integer({ min: 0, max: last.since(first).days })
      .chain((offset) => {
        const trigger = first.add({ days: offset });
        const remaining = safeNominalEnd(jurisdiction);
        const maxDays = remaining.since(trigger).days;
        const amounts = {
          [DEADLINE_UNIT.DAY]: fc.integer({ min: 1, max: maxDays }),
          [DEADLINE_UNIT.WEEK]: fc.integer({
            min: 1,
            max: Math.floor(maxDays / 7),
          }),
          [DEADLINE_UNIT.MONTH]: fc.integer({
            min: 1,
            max: remaining.since(trigger, { largestUnit: "month" }).months,
          }),
          [DEADLINE_UNIT.YEAR]: fc.integer({
            min: 1,
            max: remaining.since(trigger, { largestUnit: "year" }).years,
          }),
        } as const satisfies Record<DeadlineUnit, fc.Arbitrary<number>>;
        return fc
          .record(amounts)
          .map((amountByUnit) => ({ jurisdiction, trigger, amountByUnit }));
      });
  });

const oneOfEachUnit = {
  [DEADLINE_UNIT.DAY]: 1,
  [DEADLINE_UNIT.WEEK]: 1,
  [DEADLINE_UNIT.MONTH]: 1,
  [DEADLINE_UNIT.YEAR]: 1,
} as const satisfies Record<DeadlineUnit, number>;

const boundaryExamples = jurisdictions.flatMap((jurisdiction) => {
  const { firstYear } = HOLIDAY_COVERAGE[jurisdiction];
  const latestTrigger = safeNominalEnd(jurisdiction).subtract({ years: 1 });
  const examples = [];
  for (let year = firstYear; year <= latestTrigger.year; year++) {
    for (let month = 1; month <= 12; month++) {
      const start = Temporal.PlainDate.from({ year, month, day: 1 });
      const trigger = start.with({ day: start.daysInMonth });
      if (Temporal.PlainDate.compare(trigger, latestTrigger) > 0) {
        continue;
      }
      const example = { jurisdiction, trigger, amountByUnit: oneOfEachUnit };
      examples.push([example] satisfies [typeof example]);
    }
  }
  return examples;
});

const GENERATED_CASE_COUNT = 100;

test("adjusted deadlines explain every skipped day and stop at the first working day", () => {
  const calendar = createHolidayCalendar();
  assertProperty(
    "adjusted deadlines explain every skipped day and stop at the first working day",
    fc.property(
      deadlineCaseArbitrary,
      ({ trigger, jurisdiction, amountByUnit }) => {
        for (const unit of Object.values(DEADLINE_UNIT)) {
          const period = { amount: amountByUnit[unit], unit };
          const originalTrigger = trigger.toString();
          const originalPeriod = { ...period };
          const options = { jurisdiction, trigger, period, calendar };
          const value = computeDeadline(options).unwrap();
          expect(
            Temporal.PlainDate.compare(value.nominalEnd, trigger),
          ).toBeGreaterThan(0);
          expect(
            Temporal.PlainDate.compare(value.end, value.nominalEnd),
          ).toBeGreaterThanOrEqual(0);
          expect(value.end.dayOfWeek).toBeLessThanOrEqual(5);
          expect(
            calendar
              .getPublicHoliday({ jurisdiction, date: value.end })
              .unwrap(),
          ).toBeNull();
          expect(value.shifts.length).toBe(
            value.end.since(value.nominalEnd).days,
          );
          for (const [offset, shift] of value.shifts.entries()) {
            expect(
              shift.date.equals(value.nominalEnd.add({ days: offset })),
            ).toBe(true);
            const holiday = calendar
              .getPublicHoliday({ jurisdiction, date: shift.date })
              .unwrap();
            if (holiday) {
              expect(shift.reason).toEqual({
                type: "public-holiday",
                names: holiday.names,
              });
            } else {
              expect(shift.date.dayOfWeek).toBeGreaterThanOrEqual(6);
              expect(shift.reason).toEqual({
                type: "weekend",
                dayOfWeek: shift.date.dayOfWeek,
              });
            }
          }
          expect(computeDeadline(options).unwrap()).toEqual(value);
          expect(trigger.toString()).toBe(originalTrigger);
          expect(period).toEqual(originalPeriod);
        }
      },
    ),
    // Explicit examples consume fast-check's run budget too.
    {
      examples: boundaryExamples,
      numRuns: boundaryExamples.length + GENERATED_CASE_COUNT,
    },
  );
});

test("non-working calendars terminate at the bounded adjustment limit", () => {
  assertProperty(
    "non-working calendars terminate at the bounded adjustment limit",
    fc.property(
      triggerArbitrary,
      fc.constantFrom(...jurisdictions),
      (trigger, jurisdiction) => {
        const calendar: HolidayCalendar = {
          courtHolidays: { type: "unsupported" },
          getPublicHoliday: () => Result.ok({ names: ["Closed"] }),
        };
        const result = computeDeadline({
          jurisdiction,
          trigger,
          period: { amount: 1, unit: DEADLINE_UNIT.DAY },
          calendar,
        });
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.reason).toBe("adjustment_limit");
          expect("date" in result.error && result.error.date).toBe(
            trigger.add({ days: 32 }).toString(),
          );
        }
      },
    ),
  );
});

test("calendar failures propagate unchanged at every adjustment position", () => {
  assertProperty(
    "calendar failures propagate unchanged at every adjustment position",
    fc.property(
      triggerArbitrary,
      fc.integer({ min: 0, max: 31 }),
      (trigger, offset) => {
        const failedDate = trigger.add({ days: offset + 1 });
        const failure = new DeadlineError({
          message: "Calendar unavailable",
          reason: "calendar_failure",
          date: failedDate.toString(),
        });
        const calendar: HolidayCalendar = {
          courtHolidays: { type: "unsupported" },
          getPublicHoliday: ({ date }) =>
            date.equals(failedDate)
              ? Result.err(failure)
              : Result.ok({ names: ["Closed"] }),
        };
        const result = computeDeadline({
          jurisdiction: "CZ",
          trigger,
          period: { amount: 1, unit: DEADLINE_UNIT.DAY },
          calendar,
        });
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error).toBe(failure);
        }
      },
    ),
  );
});
