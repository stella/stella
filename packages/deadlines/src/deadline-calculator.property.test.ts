import { Result } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { Temporal } from "@stll/time";

import {
  createDeadlineCalculator,
  DEADLINE_UNIT,
  type DeadlineRuleSet,
  type HolidayCalendar,
} from "./compute-deadline";

const baseRule = {
  triggerDay: "exclude",
  dayCounting: "calendar",
  monthEnd: "constrain",
  endAdjustment: "none",
  courtHolidays: "ignore",
  weekendDays: [5, 6],
  limits: { maxCountingDays: 100, maxShiftDays: 10 },
  source: "Synthetic property policy",
} as const satisfies DeadlineRuleSet;

const directionByAdjustment = {
  "next-working-day": 1,
  "previous-working-day": -1,
  none: 0,
} as const satisfies Record<DeadlineRuleSet["endAdjustment"], number>;
const includesTrigger = {
  include: true,
  exclude: false,
} as const satisfies Record<DeadlineRuleSet["triggerDay"], boolean>;
const isClosure = (date: Temporal.PlainDate) =>
  date.day === 10 || date.day === 11;
const courtClosuresByPolicy = {
  ignore: false,
  observe: true,
} as const satisfies Record<DeadlineRuleSet["courtHolidays"], boolean>;
const isCourtClosure = (date: Temporal.PlainDate) =>
  date.day === 12 || date.day === 13;
const isWeekend = (date: Temporal.PlainDate) =>
  baseRule.weekendDays.some((day) => day === date.dayOfWeek);
const isWorking = (date: Temporal.PlainDate) =>
  !isWeekend(date) && !isClosure(date);
const calendar: HolidayCalendar = {
  getPublicHoliday: ({ date }) =>
    Result.ok(isClosure(date) ? { names: ["Closure"] } : null),
  courtHolidays: {
    type: "available",
    getHoliday: ({ date }) =>
      Result.ok(isCourtClosure(date) ? { names: ["Court closure"] } : null),
  },
};
const triggers = fc
  .integer({ min: 0, max: 730 })
  .map((days) => Temporal.PlainDate.from("2024-01-01").add({ days }));

test("configured adjustments stop at the first working day in their direction", () => {
  assertProperty(
    "configured adjustments stop at the first working day in their direction",
    fc.property(
      triggers,
      fc.integer({ min: 1, max: 15 }),
      (trigger, amount) => {
        for (const endAdjustment of Object.keys(directionByAdjustment).filter(
          (key): key is keyof typeof directionByAdjustment =>
            Object.hasOwn(directionByAdjustment, key),
        )) {
          const calculate = createDeadlineCalculator({
            rules: { TEST_A: { ...baseRule, endAdjustment } },
            calendar,
          });
          const options = {
            jurisdiction: "TEST_A",
            trigger,
            period: { amount, unit: DEADLINE_UNIT.DAY },
          } as const;
          const value = calculate(options).unwrap();
          const direction = directionByAdjustment[endAdjustment];
          const distance = value.end.since(value.nominalEnd).days;
          if (direction === 0) {
            expect(value.end.equals(value.nominalEnd)).toBe(true);
            expect(value.shifts).toEqual([]);
            continue;
          }
          expect(distance * direction).toBeGreaterThanOrEqual(0);
          expect(isWorking(value.end)).toBe(true);
          expect(value.shifts.length).toBe(Math.abs(distance));
          for (const [offset, shift] of value.shifts.entries()) {
            expect(
              shift.date.equals(
                value.nominalEnd.add({ days: offset * direction }),
              ),
            ).toBe(true);
            expect(isWorking(shift.date)).toBe(false);
            expect(shift.reason.type).toBe(
              isClosure(shift.date) ? "public-holiday" : "weekend",
            );
          }
          expect(calculate(options).unwrap()).toEqual(value);
        }
      },
    ),
  );
});

test("working-day periods contain exactly the requested eligible dates", () => {
  assertProperty(
    "working-day periods contain exactly the requested eligible dates",
    fc.property(
      triggers,
      fc.integer({ min: 1, max: 15 }),
      (trigger, amount) => {
        for (const triggerDay of Object.keys(includesTrigger).filter(
          (key): key is keyof typeof includesTrigger =>
            Object.hasOwn(includesTrigger, key),
        )) {
          for (const courtHolidays of Object.keys(courtClosuresByPolicy).filter(
            (key): key is keyof typeof courtClosuresByPolicy =>
              Object.hasOwn(courtClosuresByPolicy, key),
          )) {
            const eligible = (date: Temporal.PlainDate) =>
              isWorking(date) &&
              !(courtClosuresByPolicy[courtHolidays] && isCourtClosure(date));
            const calculate = createDeadlineCalculator({
              rules: {
                TEST_A: {
                  ...baseRule,
                  triggerDay,
                  courtHolidays,
                  dayCounting: "working",
                },
              },
              calendar,
            });
            const value = calculate({
              jurisdiction: "TEST_A",
              trigger,
              period: { amount, unit: DEADLINE_UNIT.DAY },
            }).unwrap();
            const firstOffset = includesTrigger[triggerDay] ? 0 : 1;
            const lastOffset = value.nominalEnd.since(trigger).days;
            const interval = Array.from(
              { length: lastOffset - firstOffset + 1 },
              (_, offset) => trigger.add({ days: firstOffset + offset }),
            );
            expect(interval.filter(eligible).length).toBe(amount);
            expect(eligible(value.nominalEnd)).toBe(true);
            expect(interval.slice(0, -1).filter(eligible).length).toBe(
              amount - 1,
            );
            expect(value.end.equals(value.nominalEnd)).toBe(true);
            expect(value.shifts).toEqual([]);
          }
        }
      },
    ),
  );
});
