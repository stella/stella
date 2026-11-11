import { Result } from "better-result";
import { expect, test } from "bun:test";

import { Temporal } from "@stll/time";

import {
  createDeadlineCalculator,
  DEADLINE_UNIT,
  DeadlineError,
  type DeadlineRuleSet,
  type HolidayCalendar,
} from "./compute-deadline";

const date = (value: string) => Temporal.PlainDate.from(value);
const baseRule = {
  triggerDay: "exclude",
  dayCounting: "calendar",
  monthEnd: "constrain",
  endAdjustment: "none",
  courtHolidays: "ignore",
  weekendDays: [5, 6],
  limits: { maxCountingDays: 30, maxShiftDays: 10 },
  source: "Synthetic test policy",
} as const satisfies DeadlineRuleSet;

const calendar: HolidayCalendar = {
  getPublicHoliday: () => Result.ok(null),
  courtHolidays: { type: "unsupported" },
};

test.each(["source", "limits", "weekendDays"] as const)(
  "runtime malformed %s returns a configuration error",
  (field) => {
    const malformed = { ...baseRule };
    Object.defineProperty(malformed, field, { value: null });
    const calculate = createDeadlineCalculator({
      rules: { TEST_A: malformed },
      calendar,
    });
    const result = calculate({
      jurisdiction: "TEST_A",
      trigger: date("2026-01-01"),
      period: { amount: 1, unit: DEADLINE_UNIT.DAY },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.reason).toBe("invalid_rule");
    }
  },
);

test.each([
  { triggerDay: "exclude", unit: DEADLINE_UNIT.DAY, end: "2026-01-02" },
  { triggerDay: "include", unit: DEADLINE_UNIT.DAY, end: "2026-01-01" },
  { triggerDay: "exclude", unit: DEADLINE_UNIT.WEEK, end: "2026-01-08" },
  { triggerDay: "include", unit: DEADLINE_UNIT.WEEK, end: "2026-01-07" },
  { triggerDay: "exclude", unit: DEADLINE_UNIT.MONTH, end: "2026-02-01" },
  { triggerDay: "include", unit: DEADLINE_UNIT.MONTH, end: "2026-01-31" },
  { triggerDay: "exclude", unit: DEADLINE_UNIT.YEAR, end: "2027-01-01" },
  { triggerDay: "include", unit: DEADLINE_UNIT.YEAR, end: "2026-12-31" },
] as const)(
  "$triggerDay counts one $unit to $end",
  ({ triggerDay, unit, end }) => {
    const calculate = createDeadlineCalculator({
      rules: { TEST_A: { ...baseRule, triggerDay } },
      calendar,
    });
    const value = calculate({
      jurisdiction: "TEST_A",
      trigger: date("2026-01-01"),
      period: { amount: 1, unit },
    }).unwrap();
    expect(value.nominalEnd.toString()).toBe(end);
    expect(value.rule.jurisdiction).toBe("TEST_A");
  },
);

test.each([
  {
    endAdjustment: "next-working-day",
    end: "2026-01-04",
    shifts: ["2026-01-02", "2026-01-03"],
  },
  {
    endAdjustment: "previous-working-day",
    end: "2026-01-01",
    shifts: ["2026-01-02"],
  },
  { endAdjustment: "none", end: "2026-01-02", shifts: [] },
] as const)(
  "$endAdjustment respects a Friday/Saturday weekend",
  ({ endAdjustment, end, shifts }) => {
    const calculate = createDeadlineCalculator({
      rules: { TEST_B: { ...baseRule, endAdjustment } },
      calendar,
    });
    const value = calculate({
      jurisdiction: "TEST_B",
      trigger: date("2026-01-01"),
      period: { amount: 1, unit: DEADLINE_UNIT.DAY },
    }).unwrap();
    expect(value.end.toString()).toBe(end);
    expect(value.shifts.map((shift) => shift.date.toString())).toEqual(
      Array.from(shifts),
    );
  },
);

test.each([
  { trigger: "2026-01-31", unit: DEADLINE_UNIT.MONTH, end: "2026-02-28" },
  { trigger: "2024-02-29", unit: DEADLINE_UNIT.YEAR, end: "2025-02-28" },
] as const)(
  "month-end policies govern $trigger plus one $unit",
  ({ trigger, unit, end }) => {
    for (const monthEnd of ["constrain", "reject"] as const) {
      const calculate = createDeadlineCalculator({
        rules: { TEST_A: { ...baseRule, monthEnd } },
        calendar,
      });
      const result = calculate({
        jurisdiction: "TEST_A",
        trigger: date(trigger),
        period: { amount: 1, unit },
      });
      if (monthEnd === "constrain") {
        expect(result.unwrap().nominalEnd.toString()).toBe(end);
      } else {
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.reason).toBe("missing_target_day");
        }
      }
    }
  },
);

test.each([
  { triggerDay: "include", trigger: "2026-01-01", end: "2026-01-01" },
  { triggerDay: "exclude", trigger: "2026-01-01", end: "2026-01-05" },
  { triggerDay: "include", trigger: "2026-01-02", end: "2026-01-05" },
  { triggerDay: "exclude", trigger: "2026-01-02", end: "2026-01-05" },
] as const)(
  "working days $triggerDay the trigger $trigger",
  ({ triggerDay, trigger, end }) => {
    const closedCalendar: HolidayCalendar = {
      ...calendar,
      getPublicHoliday: ({ date: current }) =>
        Result.ok(
          current.toString() === "2026-01-04" ? { names: ["Closure"] } : null,
        ),
    };
    const calculate = createDeadlineCalculator({
      rules: { TEST_A: { ...baseRule, triggerDay, dayCounting: "working" } },
      calendar: closedCalendar,
    });
    expect(
      calculate({
        jurisdiction: "TEST_A",
        trigger: date(trigger),
        period: { amount: 1, unit: DEADLINE_UNIT.DAY },
      })
        .unwrap()
        .nominalEnd.toString(),
    ).toBe(end);
  },
);

test("working-day counting leaves week arithmetic on the calendar", () => {
  const calculate = createDeadlineCalculator({
    rules: { TEST_A: { ...baseRule, dayCounting: "working" } },
    calendar,
  });
  expect(
    calculate({
      jurisdiction: "TEST_A",
      trigger: date("2026-01-01"),
      period: { amount: 1, unit: DEADLINE_UNIT.WEEK },
    })
      .unwrap()
      .nominalEnd.toString(),
  ).toBe("2026-01-08");
});

test("court closures are optional and public holidays own overlapping explanations", () => {
  const closures: HolidayCalendar = {
    getPublicHoliday: ({ date: current }) =>
      Result.ok(
        current.toString() === "2026-01-02" ? { names: ["Public"] } : null,
      ),
    courtHolidays: {
      type: "available",
      getHoliday: ({ date: current }) =>
        Result.ok(
          current.toString() <= "2026-01-04" ? { names: ["Court"] } : null,
        ),
    },
  };
  for (const courtHolidays of ["ignore", "observe"] as const) {
    const calculate = createDeadlineCalculator({
      rules: {
        TEST_A: {
          ...baseRule,
          courtHolidays,
          endAdjustment: "next-working-day",
        },
      },
      calendar: closures,
    });
    const value = calculate({
      jurisdiction: "TEST_A",
      trigger: date("2026-01-01"),
      period: { amount: 1, unit: DEADLINE_UNIT.DAY },
    }).unwrap();
    expect(value.end.toString()).toBe(
      courtHolidays === "observe" ? "2026-01-05" : "2026-01-04",
    );
    expect(value.shifts.at(0)?.reason.type).toBe("public-holiday");
    expect(value.shifts.at(1)?.reason.type).toBe(
      courtHolidays === "observe" ? "court-holiday" : "weekend",
    );
  }
});

test("ignored court calendars are never queried", () => {
  const failure = new DeadlineError({
    message: "Court unavailable",
    reason: "calendar_failure",
  });
  const calculate = createDeadlineCalculator({
    rules: { TEST_A: baseRule },
    calendar: {
      ...calendar,
      courtHolidays: {
        type: "available",
        getHoliday: () => Result.err(failure),
      },
    },
  });
  expect(
    calculate({
      jurisdiction: "TEST_A",
      trigger: date("2026-01-01"),
      period: { amount: 1, unit: DEADLINE_UNIT.DAY },
    }).isOk(),
  ).toBe(true);
});

test("observed court lookup failures propagate unchanged", () => {
  const failure = new DeadlineError({
    message: "Court unavailable",
    reason: "calendar_failure",
  });
  const calculate = createDeadlineCalculator({
    rules: { TEST_A: { ...baseRule, courtHolidays: "observe" } },
    calendar: {
      ...calendar,
      courtHolidays: {
        type: "available",
        getHoliday: () => Result.err(failure),
      },
    },
  });
  const result = calculate({
    jurisdiction: "TEST_A",
    trigger: date("2026-01-01"),
    period: { amount: 1, unit: DEADLINE_UNIT.DAY },
  });
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error).toBe(failure);
  }
});

test("included constrained months subtract a day after constraining", () => {
  const calculate = createDeadlineCalculator({
    rules: { TEST_A: { ...baseRule, triggerDay: "include" } },
    calendar,
  });
  const value = calculate({
    jurisdiction: "TEST_A",
    trigger: date("2026-01-31"),
    period: { amount: 1, unit: DEADLINE_UNIT.MONTH },
  }).unwrap();
  expect(value.nominalEnd.toString()).toBe("2026-02-27");
});

test.each([
  { trigger: "+275760-08-14", unit: DEADLINE_UNIT.MONTH },
  { trigger: "+275759-09-14", unit: DEADLINE_UNIT.YEAR },
] as const)(
  "inclusive month and year periods avoid out-of-range intermediate dates: $unit",
  ({ trigger, unit }) => {
    const calculate = createDeadlineCalculator({
      rules: { TEST_A: { ...baseRule, triggerDay: "include" } },
      calendar,
    });
    const value = calculate({
      jurisdiction: "TEST_A",
      trigger: date(trigger),
      period: { amount: 1, unit },
    }).unwrap();
    expect(value.nominalEnd.toString()).toBe("+275760-09-13");
    expect(value.end.equals(value.nominalEnd)).toBe(true);
  },
);

test("an included single day can end at the maximum supported date", () => {
  const trigger = date("+275760-09-13");
  const calculate = createDeadlineCalculator({
    rules: { TEST_A: { ...baseRule, triggerDay: "include" } },
    calendar,
  });
  const value = calculate({
    jurisdiction: "TEST_A",
    trigger,
    period: { amount: 1, unit: DEADLINE_UNIT.DAY },
  }).unwrap();
  expect(value.nominalEnd.equals(trigger)).toBe(true);
  expect(value.end.equals(trigger)).toBe(true);
  expect(value.shifts).toEqual([]);
});

test.each([
  {
    rule: { ...baseRule, courtHolidays: "observe" },
    reason: "unsupported_calendar_capability",
  },
  { rule: { ...baseRule, source: "" }, reason: "invalid_rule" },
  {
    rule: { ...baseRule, limits: { maxCountingDays: 0, maxShiftDays: 10 } },
    reason: "invalid_rule",
  },
  {
    rule: { ...baseRule, limits: { maxCountingDays: 30, maxShiftDays: -1 } },
    reason: "invalid_rule",
  },
] as const)("rejects $reason without a partial answer", ({ rule, reason }) => {
  const calculate = createDeadlineCalculator({
    rules: { TEST_A: rule },
    calendar,
  });
  const result = calculate({
    jurisdiction: "TEST_A",
    trigger: date("2026-01-01"),
    period: { amount: 1, unit: DEADLINE_UNIT.DAY },
  });
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.reason).toBe(reason);
  }
});

test.each([
  { dayCounting: "working", endAdjustment: "none", reason: "counting_limit" },
  {
    dayCounting: "calendar",
    endAdjustment: "next-working-day",
    reason: "adjustment_limit",
  },
  {
    dayCounting: "calendar",
    endAdjustment: "previous-working-day",
    reason: "adjustment_limit",
  },
] as const)(
  "permanent closures terminate with $reason",
  ({ dayCounting, endAdjustment, reason }) => {
    const calculate = createDeadlineCalculator({
      rules: { TEST_A: { ...baseRule, dayCounting, endAdjustment } },
      calendar: {
        ...calendar,
        getPublicHoliday: () => Result.ok({ names: ["Closed"] }),
      },
    });
    const result = calculate({
      jurisdiction: "TEST_A",
      trigger: date("2026-01-01"),
      period: { amount: 1, unit: DEADLINE_UNIT.DAY },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.reason).toBe(reason);
    }
  },
);

test.each(["unsupported_date", "calendar_failure"] as const)(
  "preserves %s errors from the calendar",
  (reason) => {
    const failure = new DeadlineError({
      message: "Calendar unavailable",
      reason,
    });
    const calculate = createDeadlineCalculator({
      rules: { TEST_A: { ...baseRule, endAdjustment: "next-working-day" } },
      calendar: { ...calendar, getPublicHoliday: () => Result.err(failure) },
    });
    const result = calculate({
      jurisdiction: "TEST_A",
      trigger: date("2026-01-01"),
      period: { amount: 1, unit: DEADLINE_UNIT.DAY },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBe(failure);
    }
  },
);
