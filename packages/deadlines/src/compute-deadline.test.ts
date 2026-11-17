import { Result } from "better-result";
import { expect, test } from "bun:test";

import { Temporal } from "@stll/time";

import {
  computeDeadline,
  createHolidayCalendar,
  DEADLINE_UNIT,
  DeadlineError,
  type DeadlinePeriod,
  type HolidayCalendar,
} from "./compute-deadline";

const date = (value: string) => Temporal.PlainDate.from(value);

const examples = [
  {
    trigger: "2026-01-02",
    unit: DEADLINE_UNIT.DAY,
    nominal: "2026-01-03",
    end: "2026-01-05",
  },
  {
    trigger: "2026-01-02",
    unit: DEADLINE_UNIT.WEEK,
    nominal: "2026-01-09",
    end: "2026-01-09",
  },
  {
    trigger: "2026-01-31",
    unit: DEADLINE_UNIT.MONTH,
    nominal: "2026-02-28",
    end: "2026-03-02",
  },
  {
    trigger: "2024-02-29",
    unit: DEADLINE_UNIT.YEAR,
    nominal: "2025-02-28",
    end: "2025-02-28",
  },
  {
    trigger: "2026-04-02",
    unit: DEADLINE_UNIT.DAY,
    nominal: "2026-04-03",
    end: "2026-04-07",
  },
  {
    trigger: "2023-12-22",
    unit: DEADLINE_UNIT.DAY,
    nominal: "2023-12-23",
    end: "2023-12-27",
  },
] as const satisfies readonly {
  trigger: string;
  unit: DeadlinePeriod["unit"];
  nominal: string;
  end: string;
}[];

for (const jurisdiction of ["CZ", "SK"] as const) {
  test.each(examples)(
    `${jurisdiction} adjusts $trigger plus one $unit to the first working day`,
    ({ trigger, unit, nominal, end }) => {
      const value = computeDeadline({
        jurisdiction,
        trigger: date(trigger),
        period: { amount: 1, unit },
      }).unwrap();
      expect(value.nominalEnd.toString()).toBe(nominal);
      expect(value.end.toString()).toBe(end);
      expect(value.shifts.map((shift) => shift.date.toString())).toEqual(
        Array.from({ length: date(end).since(date(nominal)).days }, (_, days) =>
          date(nominal).add({ days }).toString(),
        ),
      );
      expect(value.rule.jurisdiction).toBe(jurisdiction);
      expect(value.rule.source.length).toBeGreaterThan(0);
    },
  );
}

test("public holidays take precedence over weekends in the explanation", () => {
  const value = computeDeadline({
    jurisdiction: "SK",
    trigger: date("2023-12-23"),
    period: { amount: 1, unit: DEADLINE_UNIT.DAY },
  }).unwrap();
  const first = value.shifts.at(0);
  expect(first?.date.dayOfWeek).toBe(7);
  expect(first?.reason.type).toBe("public-holiday");
  if (first?.reason.type === "public-holiday") {
    expect(first.reason.names.length).toBeGreaterThan(0);
  }
});

test.each([
  { jurisdiction: "SK", day: "2026-09-15", holiday: false },
  { jurisdiction: "CZ", day: "2026-09-28", holiday: true },
  { jurisdiction: "SK", day: "2024-11-17", holiday: true },
  { jurisdiction: "SK", day: "2025-11-17", holiday: false },
  { jurisdiction: "SK", day: "2023-09-01", holiday: true },
  { jurisdiction: "SK", day: "2024-09-01", holiday: false },
  { jurisdiction: "SK", day: "2025-05-08", holiday: true },
  { jurisdiction: "SK", day: "2026-05-08", holiday: false },
] as const)(
  "$jurisdiction classifies $day using the rules effective that year",
  ({ jurisdiction, day, holiday }) => {
    const classification = createHolidayCalendar()
      .getPublicHoliday({ jurisdiction, date: date(day) })
      .unwrap();
    expect(classification !== null).toBe(holiday);
  },
);

test.each([
  { jurisdiction: "CZ", trigger: "2015-12-31", amount: 1 },
  { jurisdiction: "SK", trigger: "2018-12-31", amount: 1 },
  { jurisdiction: "CZ", trigger: "2026-12-31", amount: 1 },
  { jurisdiction: "SK", trigger: "2026-12-31", amount: 1 },
] as const)(
  "$jurisdiction refuses unsupported trigger or nominal dates from $trigger",
  ({ jurisdiction, trigger, amount }) => {
    const result = computeDeadline({
      jurisdiction,
      trigger: date(trigger),
      period: { amount, unit: DEADLINE_UNIT.DAY },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.reason).toBe("unsupported_date");
    }
  },
);

test("an unsupported shifted date returns an error instead of a partial calculation", () => {
  const calendar: HolidayCalendar = {
    courtHolidays: { type: "unsupported" },
    getPublicHoliday: ({ jurisdiction, date: current }) =>
      current.toString() === "2026-01-04"
        ? Result.err(
            new DeadlineError({
              message: "Coverage ended",
              reason: "unsupported_date",
              jurisdiction,
              date: current.toString(),
            }),
          )
        : Result.ok(null),
  };
  const result = computeDeadline({
    jurisdiction: "CZ",
    trigger: date("2026-01-02"),
    period: { amount: 1, unit: DEADLINE_UNIT.DAY },
    calendar,
  });
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.reason).toBe("unsupported_date");
  }
});

test("invalid periods preserve the nominal validation error", () => {
  const result = computeDeadline({
    jurisdiction: "CZ",
    trigger: date("2026-01-02"),
    period: { amount: 0, unit: DEADLINE_UNIT.DAY },
  });
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.reason).toBe("invalid_period_amount");
  }
});
