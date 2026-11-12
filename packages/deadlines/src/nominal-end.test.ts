import { expect, test } from "bun:test";

import { Temporal } from "@stll/time";

import {
  computeNominalEnd,
  type ComputeNominalEndOptions,
  DEADLINE_UNIT,
  type DeadlinePeriod,
} from "./nominal-end";

const date = (value: string) => Temporal.PlainDate.from(value);

type NominalWorkedExample = Omit<ComputeNominalEndOptions, "period"> & {
  name: string;
  amount: DeadlinePeriod["amount"];
  unit: DeadlinePeriod["unit"];
  expected: string;
};

const nominalWorkedExamples = [
  {
    name: "one day excludes the trigger date",
    trigger: date("2026-01-01"),
    amount: 1,
    unit: DEADLINE_UNIT.DAY,
    expected: "2026-01-02",
  },
  {
    name: "seven days exclude the trigger date",
    trigger: date("2026-01-01"),
    amount: 7,
    unit: DEADLINE_UNIT.DAY,
    expected: "2026-01-08",
  },
  {
    name: "day period crosses a year boundary",
    trigger: date("2026-12-31"),
    amount: 1,
    unit: DEADLINE_UNIT.DAY,
    expected: "2027-01-01",
  },
  {
    name: "week period crosses a year boundary",
    trigger: date("2026-12-31"),
    amount: 1,
    unit: DEADLINE_UNIT.WEEK,
    expected: "2027-01-07",
  },
  {
    name: "month period crosses a year boundary",
    trigger: date("2026-12-31"),
    amount: 1,
    unit: DEADLINE_UNIT.MONTH,
    expected: "2027-01-31",
  },
  {
    name: "year period crosses a year boundary",
    trigger: date("2026-12-31"),
    amount: 1,
    unit: DEADLINE_UNIT.YEAR,
    expected: "2027-12-31",
  },
  {
    name: "month period constrains an absent day",
    trigger: date("2026-01-31"),
    amount: 1,
    unit: DEADLINE_UNIT.MONTH,
    expected: "2026-02-28",
  },
  {
    name: "multiple months constrain once at the target month",
    trigger: date("2026-01-31"),
    amount: 2,
    unit: DEADLINE_UNIT.MONTH,
    expected: "2026-03-31",
  },
  {
    name: "non-leap target year constrains February 29",
    trigger: date("2024-02-29"),
    amount: 1,
    unit: DEADLINE_UNIT.YEAR,
    expected: "2025-02-28",
  },
  {
    name: "leap target year retains February 29",
    trigger: date("2024-02-29"),
    amount: 4,
    unit: DEADLINE_UNIT.YEAR,
    expected: "2028-02-29",
  },
  {
    name: "year 2000 is a leap year",
    trigger: date("2000-02-29"),
    amount: 1,
    unit: DEADLINE_UNIT.YEAR,
    expected: "2001-02-28",
  },
  {
    name: "year 1900 is not a leap year",
    trigger: date("1900-02-28"),
    amount: 1,
    unit: DEADLINE_UNIT.DAY,
    expected: "1900-03-01",
  },
  {
    name: "year zero is a leap year",
    trigger: date("0000-02-28"),
    amount: 1,
    unit: DEADLINE_UNIT.DAY,
    expected: "0000-02-29",
  },
  {
    name: "weekend day remains on Saturday",
    trigger: date("2026-01-02"),
    amount: 1,
    unit: DEADLINE_UNIT.DAY,
    expected: "2026-01-03",
  },
  {
    name: "weekend week period remains on Friday",
    trigger: date("2026-01-02"),
    amount: 1,
    unit: DEADLINE_UNIT.WEEK,
    expected: "2026-01-09",
  },
  {
    name: "lower supported date advances by one day",
    trigger: date("-271821-04-19"),
    amount: 1,
    unit: DEADLINE_UNIT.DAY,
    expected: "-271821-04-20",
  },
  {
    name: "lower supported date advances by one month",
    trigger: date("-271821-04-19"),
    amount: 1,
    unit: DEADLINE_UNIT.MONTH,
    expected: "-271821-05-19",
  },
  {
    name: "lower supported date advances by one year",
    trigger: date("-271821-04-19"),
    amount: 1,
    unit: DEADLINE_UNIT.YEAR,
    expected: "-271820-04-19",
  },
] as const satisfies readonly NominalWorkedExample[];

test.each(nominalWorkedExamples)(
  "$name",
  ({ trigger, amount, unit, expected }) => {
    expect(
      computeNominalEnd({ trigger, period: { amount, unit } })
        .unwrap()
        .toString(),
    ).toBe(expected);
  },
);

test("invalid amounts return the specific validation reason", () => {
  for (const amount of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1.5,
    0,
    -1,
    Number.MAX_SAFE_INTEGER + 1,
    Number.MAX_VALUE,
  ]) {
    const result = computeNominalEnd({
      trigger: date("2026-01-01"),
      period: { amount, unit: DEADLINE_UNIT.DAY },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.reason).toBe("invalid_period_amount");
    }
  }
});

test("non-ISO calendars return the specific calendar reason", () => {
  const trigger = Temporal.PlainDate.from({
    year: 2026,
    month: 1,
    day: 1,
    calendar: "gregory",
  });
  const result = computeNominalEnd({
    trigger,
    period: { amount: 1, unit: DEADLINE_UNIT.DAY },
  });
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.reason).toBe("unsupported_calendar");
  }
});

test("periods beyond Temporal's supported date range return a range reason", () => {
  const result = computeNominalEnd({
    trigger: date("+275760-09-13"),
    period: { amount: 1, unit: DEADLINE_UNIT.DAY },
  });
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.reason).toBe("date_out_of_range");
  }
});
