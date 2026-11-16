import { panic, Result, TaggedError } from "better-result";

import type { Temporal } from "@stll/time";

export const DEADLINE_UNIT = {
  DAY: "day",
  WEEK: "week",
  MONTH: "month",
  YEAR: "year",
} as const;

export type DeadlineUnit = (typeof DEADLINE_UNIT)[keyof typeof DEADLINE_UNIT];

export type DeadlinePeriod = {
  amount: number;
  unit: DeadlineUnit;
};

const ERROR_REASON = {
  INVALID_PERIOD_AMOUNT: "invalid_period_amount",
  UNSUPPORTED_CALENDAR: "unsupported_calendar",
  DATE_OUT_OF_RANGE: "date_out_of_range",
  MISSING_TARGET_DAY: "missing_target_day",
} as const;

export class NominalDeadlineError extends TaggedError("NominalDeadlineError")<{
  message: string;
  reason: (typeof ERROR_REASON)[keyof typeof ERROR_REASON];
  cause?: unknown;
}> {}

const SUPPORTED_CALENDAR = "iso8601";

export type ComputeNominalEndOptions = {
  trigger: Temporal.PlainDate;
  period: DeadlinePeriod;
  monthEnd?: "constrain" | "reject";
  triggerDay?: "exclude" | "include";
};

export const getTriggerOffset = (
  policy: NonNullable<ComputeNominalEndOptions["triggerDay"]>,
) => {
  switch (policy) {
    case "exclude":
      return 1;
    case "include":
      return 0;
    default:
      policy satisfies never;
      return panic("Unexpected trigger-day policy.", policy);
  }
};

const arithmeticError = (cause: unknown) => {
  if (!(cause instanceof RangeError)) {
    return panic("Unexpected nominal deadline arithmetic failure.", cause);
  }
  return new NominalDeadlineError({
    message: "The nominal deadline exceeds the supported calendar date range.",
    reason: ERROR_REASON.DATE_OUT_OF_RANGE,
    cause,
  });
};

export const addCalendarDays = (date: Temporal.PlainDate, days: number) =>
  Result.try({ try: () => date.add({ days }), catch: arithmeticError });

export const validateNominalInput = ({
  trigger,
  period,
}: Pick<ComputeNominalEndOptions, "trigger" | "period">) => {
  if (!Number.isSafeInteger(period.amount) || period.amount <= 0) {
    return Result.err(
      new NominalDeadlineError({
        message: "Deadline period amount must be a positive safe integer.",
        reason: ERROR_REASON.INVALID_PERIOD_AMOUNT,
      }),
    );
  }

  if (trigger.calendarId !== SUPPORTED_CALENDAR) {
    return Result.err(
      new NominalDeadlineError({
        message:
          "Nominal deadline calculations require an ISO 8601 calendar date.",
        reason: ERROR_REASON.UNSUPPORTED_CALENDAR,
      }),
    );
  }

  return Result.ok(undefined);
};

/** Calendar-only end before any weekend, holiday, or jurisdictional adjustment. */
export const computeNominalEnd = ({
  trigger,
  period,
  monthEnd = "constrain",
  triggerDay = "exclude",
}: ComputeNominalEndOptions) => {
  const validation = validateNominalInput({ trigger, period });
  if (validation.isErr()) {
    return validation;
  }
  const inclusiveOffset = 1 - getTriggerOffset(triggerDay);
  switch (period.unit) {
    case DEADLINE_UNIT.DAY:
      return addCalendarDays(trigger, period.amount - inclusiveOffset);
    case DEADLINE_UNIT.WEEK:
      return addCalendarDays(trigger, period.amount * 7 - inclusiveOffset);
    case DEADLINE_UNIT.MONTH:
    case DEADLINE_UNIT.YEAR:
      break;
    default:
      period.unit satisfies never;
      return panic("Unexpected deadline period unit.", period.unit);
  }

  // Resolve the target month before constructing its date: an inclusive result
  // can be representable even when the exclusive intermediate date is not.
  // The trigger's month reference can precede PlainDate's lower boundary.
  // Positive periods let us construct the target reference directly instead.
  const monthIndex =
    trigger.month -
    1 +
    (period.unit === DEADLINE_UNIT.MONTH ? period.amount : 0);
  const year =
    trigger.year +
    (period.unit === DEADLINE_UNIT.YEAR
      ? period.amount
      : Math.floor(monthIndex / 12));
  const month = (monthIndex % 12) + 1;
  const target = Result.try({
    try: () =>
      trigger
        .with({ year, month, day: 1 }, { overflow: "reject" })
        .toPlainYearMonth(),
    catch: arithmeticError,
  });
  if (target.isErr()) {
    return target;
  }
  const nominalDay = Math.min(trigger.day, target.value.daysInMonth);
  switch (monthEnd) {
    case "constrain":
      break;
    case "reject":
      if (nominalDay !== trigger.day) {
        return Result.err(
          new NominalDeadlineError({
            message: "The target month has no corresponding trigger day.",
            reason: ERROR_REASON.MISSING_TARGET_DAY,
          }),
        );
      }
      break;
    default:
      monthEnd satisfies never;
      return panic("Unexpected month-end policy.", monthEnd);
  }
  return Result.try({
    try: () => {
      const day = nominalDay - inclusiveOffset;
      if (day > 0) {
        return target.value.toPlainDate({ day });
      }
      const previous = target.value.subtract({ months: 1 });
      return previous.toPlainDate({ day: previous.daysInMonth });
    },
    catch: arithmeticError,
  });
};
