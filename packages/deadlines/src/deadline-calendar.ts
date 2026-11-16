import { panic, Result } from "better-result";

import type { Temporal } from "@stll/time";

import { DeadlineError } from "./deadline-error";
import type { DeadlineRuleSet } from "./rules";

export type PublicHoliday = { names: readonly string[] };

export type HolidayDateOptions = {
  jurisdiction: string;
  date: Temporal.PlainDate;
};

type HolidayLookup = (
  options: HolidayDateOptions,
) => Result<PublicHoliday | null, DeadlineError>;

export type HolidayCalendar = {
  getPublicHoliday: HolidayLookup;
  courtHolidays:
    { type: "unsupported" } | { type: "available"; getHoliday: HolidayLookup };
};

export type NonWorkingReason =
  | { type: "weekend"; dayOfWeek: number }
  | { type: "public-holiday"; names: readonly string[] }
  | { type: "court-holiday"; names: readonly string[] };

type NonWorkingDayOptions = HolidayDateOptions & {
  calendar: HolidayCalendar;
  rule: DeadlineRuleSet;
};

export const getNonWorkingReason = ({
  jurisdiction,
  date,
  calendar,
  rule,
}: NonWorkingDayOptions) => {
  if (
    rule.courtHolidays === "observe" &&
    calendar.courtHolidays.type === "unsupported"
  ) {
    return Result.err(
      new DeadlineError({
        message:
          "The rule requires court holidays that the calendar cannot provide.",
        reason: "unsupported_calendar_capability",
        jurisdiction,
        date: date.toString(),
      }),
    );
  }
  const holiday = calendar.getPublicHoliday({ jurisdiction, date });
  if (holiday.isErr()) {
    return holiday;
  }
  if (holiday.value) {
    return Result.ok({
      type: "public-holiday",
      names: holiday.value.names,
    } as const);
  }
  switch (rule.courtHolidays) {
    case "ignore":
      break;
    case "observe": {
      if (calendar.courtHolidays.type === "unsupported") {
        return panic(
          "Court calendar capability was checked before classification.",
        );
      }
      const closure = calendar.courtHolidays.getHoliday({ jurisdiction, date });
      if (closure.isErr()) {
        return closure;
      }
      if (closure.value) {
        return Result.ok({
          type: "court-holiday",
          names: closure.value.names,
        } as const);
      }
      break;
    }
    default: {
      rule.courtHolidays satisfies never;
      return panic("Unexpected court holiday policy.", rule.courtHolidays);
    }
  }
  if (rule.weekendDays.some((day) => day === date.dayOfWeek)) {
    return Result.ok({ type: "weekend", dayOfWeek: date.dayOfWeek } as const);
  }
  return Result.ok(null);
};
