import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { Temporal } from "@stll/time";

import { DEADLINE_UNIT, computeNominalEnd } from "./nominal-end";

type GregorianDateParts = {
  day: number;
  month: number;
  year: number;
};

const isLeapYear = (year: number) =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

const daysInMonth = (year: number, month: number) => {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
};

const dateArbitrary = fc
  .record({
    year: fc.integer({ min: 1800, max: 2200 }),
    month: fc.integer({ min: 1, max: 12 }),
  })
  .chain(({ month, year }) =>
    fc
      .integer({ min: 1, max: daysInMonth(year, month) })
      .map((day) => ({ day, month, year })),
  );

const ordinalOf = ({ day, month, year }: GregorianDateParts) => {
  const previousYear = year - 1;
  const daysBeforeYear =
    previousYear * 365 +
    Math.floor(previousYear / 4) -
    Math.floor(previousYear / 100) +
    Math.floor(previousYear / 400);
  const daysBeforeMonth = Array.from({ length: month - 1 }, (_, index) =>
    daysInMonth(year, index + 1),
  ).reduce((total, days) => total + days, 0);
  return daysBeforeYear + daysBeforeMonth + day;
};

test("inclusive calendar periods end exactly one day before their exclusive counterparts", () => {
  assertProperty(
    "inclusive calendar periods end exactly one day before their exclusive counterparts",
    fc.property(
      dateArbitrary,
      fc.integer({ min: 1, max: 100 }),
      (parts, amount) => {
        const trigger = Temporal.PlainDate.from(parts);
        for (const unit of Object.values(DEADLINE_UNIT)) {
          const period = { amount, unit };
          const exclusive = computeNominalEnd({
            trigger,
            period,
            triggerDay: "exclude",
          }).unwrap();
          const inclusive = computeNominalEnd({
            trigger,
            period,
            triggerDay: "include",
          }).unwrap();
          expect(exclusive.since(inclusive).days).toBe(1);
        }
      },
    ),
  );
});

test("positive day periods advance by exactly their stated number of Gregorian days", () => {
  assertProperty(
    "positive day periods advance by exactly their stated number of Gregorian days",
    fc.property(
      dateArbitrary,
      fc.integer({ min: 1, max: 10_000 }),
      (parts, amount) => {
        const trigger = Temporal.PlainDate.from(parts);
        const originalTrigger = trigger.toString();
        const result = computeNominalEnd({
          trigger,
          period: { amount, unit: DEADLINE_UNIT.DAY },
        });
        const end = result.unwrap();
        const endParts = { day: end.day, month: end.month, year: end.year };
        expect(ordinalOf(endParts) - ordinalOf(parts)).toBe(amount);
        expect(trigger.toString()).toBe(originalTrigger);
      },
    ),
  );
});

test("positive month periods target the indexed month and constrain its day", () => {
  assertProperty(
    "positive month periods target the indexed month and constrain its day",
    fc.property(
      dateArbitrary,
      fc.integer({ min: 1, max: 120 }),
      (parts, amount) => {
        const trigger = Temporal.PlainDate.from(parts);
        const result = computeNominalEnd({
          trigger,
          period: { amount, unit: DEADLINE_UNIT.MONTH },
        });
        const end = result.unwrap();

        const targetMonthIndex = parts.year * 12 + parts.month - 1 + amount;
        const targetYear = Math.floor(targetMonthIndex / 12);
        const targetMonth = (targetMonthIndex % 12) + 1;
        expect(end.year).toBe(targetYear);
        expect(end.month).toBe(targetMonth);
        expect(end.day).toBe(
          Math.min(parts.day, daysInMonth(targetYear, targetMonth)),
        );
        expect(end.since(trigger, { largestUnit: "day" }).days).toBeGreaterThan(
          0,
        );
      },
    ),
  );
});

test("positive year periods target the requested year and constrain leap days", () => {
  assertProperty(
    "positive year periods target the requested year and constrain leap days",
    fc.property(
      dateArbitrary,
      fc.integer({ min: 1, max: 100 }),
      (parts, amount) => {
        const trigger = Temporal.PlainDate.from(parts);
        const result = computeNominalEnd({
          trigger,
          period: { amount, unit: DEADLINE_UNIT.YEAR },
        });
        const end = result.unwrap();

        const targetYear = parts.year + amount;
        expect(end.year).toBe(targetYear);
        expect(end.month).toBe(parts.month);
        expect(end.day).toBe(
          Math.min(parts.day, daysInMonth(targetYear, parts.month)),
        );
        expect(end.since(trigger, { largestUnit: "day" }).days).toBeGreaterThan(
          0,
        );
      },
    ),
  );
});

test("positive week periods advance by seven days per week", () => {
  assertProperty(
    "positive week periods advance by seven days per week",
    fc.property(
      dateArbitrary,
      fc.integer({ min: 1, max: 500 }),
      (parts, amount) => {
        const trigger = Temporal.PlainDate.from(parts);
        const result = computeNominalEnd({
          trigger,
          period: { amount, unit: DEADLINE_UNIT.WEEK },
        });
        const end = result.unwrap();
        expect(
          ordinalOf({ day: end.day, month: end.month, year: end.year }) -
            ordinalOf(parts),
        ).toBe(amount * 7);
      },
    ),
  );
});
