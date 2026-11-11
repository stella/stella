import { panic, Result } from "better-result";

import type { Temporal } from "@stll/time";

import {
  getNonWorkingReason,
  type HolidayCalendar,
  type NonWorkingReason,
} from "./deadline-calendar";
import { DeadlineError } from "./deadline-error";
import {
  addCalendarDays,
  computeNominalEnd,
  DEADLINE_UNIT,
  type DeadlinePeriod,
  getTriggerOffset,
  type NominalDeadlineError,
  validateNominalInput,
} from "./nominal-end";
import type { DeadlineRuleSet } from "./rules";

export type DeadlineShift = {
  readonly date: Temporal.PlainDate;
  readonly reason: NonWorkingReason;
};

export type DeadlineCalculation<Jurisdiction extends string = string> = {
  readonly end: Temporal.PlainDate;
  readonly nominalEnd: Temporal.PlainDate;
  readonly shifts: readonly DeadlineShift[];
  readonly rule: {
    readonly jurisdiction: Jurisdiction;
    readonly source: string;
  };
};

export type DeadlineInput<Jurisdiction extends string> = {
  jurisdiction: Jurisdiction;
  trigger: Temporal.PlainDate;
  period: DeadlinePeriod;
};

export type DeadlineResult<Jurisdiction extends string = string> = Result<
  DeadlineCalculation<Jurisdiction>,
  DeadlineError | NominalDeadlineError
>;

type PolicyKey = Exclude<
  keyof DeadlineRuleSet,
  "weekendDays" | "limits" | "source"
>;

const POLICY_MODES = {
  triggerDay: { exclude: true, include: true },
  dayCounting: { calendar: true, working: true },
  monthEnd: { constrain: true, reject: true },
  endAdjustment: {
    "next-working-day": true,
    "previous-working-day": true,
    none: true,
  },
  courtHolidays: { ignore: true, observe: true },
} as const satisfies { [Key in PolicyKey]: Record<DeadlineRuleSet[Key], true> };

const ADJUSTMENT_STEP = {
  "next-working-day": 1,
  "previous-working-day": -1,
  none: 0,
} as const satisfies Record<DeadlineRuleSet["endAdjustment"], -1 | 0 | 1>;

const isRuleSet = (value: unknown): value is DeadlineRuleSet => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const validModes = Object.entries(POLICY_MODES).every(([key, modes]) => {
    const candidate: unknown = Reflect.get(value, key);
    return typeof candidate === "string" && Object.hasOwn(modes, candidate);
  });
  return (
    validModes &&
    "source" in value &&
    typeof value.source === "string" &&
    value.source.trim().length > 0 &&
    "limits" in value &&
    typeof value.limits === "object" &&
    value.limits !== null &&
    "maxCountingDays" in value.limits &&
    typeof value.limits.maxCountingDays === "number" &&
    Number.isSafeInteger(value.limits.maxCountingDays) &&
    value.limits.maxCountingDays > 0 &&
    "maxShiftDays" in value.limits &&
    typeof value.limits.maxShiftDays === "number" &&
    Number.isSafeInteger(value.limits.maxShiftDays) &&
    value.limits.maxShiftDays >= 0 &&
    "weekendDays" in value &&
    Array.isArray(value.weekendDays) &&
    value.weekendDays.every(
      (day: unknown) =>
        typeof day === "number" &&
        Number.isInteger(day) &&
        day >= 1 &&
        day <= 7,
    )
  );
};

type NominalOptions = {
  jurisdiction: string;
  trigger: Temporal.PlainDate;
  period: DeadlinePeriod;
  rule: DeadlineRuleSet;
  calendar: HolidayCalendar;
};

type NominalResult = Result<
  Temporal.PlainDate,
  DeadlineError | NominalDeadlineError
>;

const countWorkingDays = ({
  jurisdiction,
  trigger,
  period,
  rule,
  calendar,
}: NominalOptions): NominalResult => {
  if (period.amount > rule.limits.maxCountingDays) {
    return Result.err(
      new DeadlineError({
        message: "The period exceeds the working-day counting limit.",
        reason: "counting_limit",
        jurisdiction,
      }),
    );
  }
  const initial = addCalendarDays(trigger, getTriggerOffset(rule.triggerDay));
  if (initial.isErr()) {
    return initial;
  }
  let date = initial.value;
  let counted = 0;
  for (let scanned = 0; scanned < rule.limits.maxCountingDays; scanned++) {
    const classification = getNonWorkingReason({
      jurisdiction,
      date,
      rule,
      calendar,
    });
    if (classification.isErr()) {
      return classification;
    }
    if (!classification.value) {
      counted++;
      if (counted === period.amount) {
        return Result.ok(date);
      }
    }
    if (scanned + 1 === rule.limits.maxCountingDays) {
      break;
    }
    const next = addCalendarDays(date, 1);
    if (next.isErr()) {
      return next;
    }
    date = next.value;
  }
  return Result.err(
    new DeadlineError({
      message:
        "The calendar did not yield enough working days within the counting limit.",
      reason: "counting_limit",
      jurisdiction,
      date: date.toString(),
    }),
  );
};

type CreateDeadlineCalculatorOptions<
  Registry extends Readonly<Record<string, DeadlineRuleSet>>,
> = {
  rules: Registry;
  calendar: HolidayCalendar;
};

export const createDeadlineCalculator =
  <const Registry extends Readonly<Record<string, DeadlineRuleSet>>>({
    rules,
    calendar,
  }: CreateDeadlineCalculatorOptions<Registry>) =>
  ({
    jurisdiction,
    trigger,
    period,
  }: DeadlineInput<Extract<keyof Registry, string>>): DeadlineResult<
    Extract<keyof Registry, string>
  > => {
    if (!Object.hasOwn(rules, jurisdiction)) {
      return Result.err(
        new DeadlineError({
          message: "The jurisdiction has no registered deadline rule set.",
          reason: "unsupported_jurisdiction",
          jurisdiction,
        }),
      );
    }
    const rule = rules[jurisdiction];
    if (!isRuleSet(rule)) {
      return Result.err(
        new DeadlineError({
          message:
            "The deadline rule has an invalid policy, source or execution limit.",
          reason: "invalid_rule",
          jurisdiction,
        }),
      );
    }
    const validation = validateNominalInput({ trigger, period });
    if (validation.isErr()) {
      return validation;
    }
    const triggerCoverage = getNonWorkingReason({
      jurisdiction,
      date: trigger,
      rule,
      calendar,
    });
    if (triggerCoverage.isErr()) {
      return triggerCoverage;
    }
    const options = { jurisdiction, trigger, period, rule, calendar };
    const nominalOptions = {
      trigger,
      period,
      monthEnd: rule.monthEnd,
      triggerDay: rule.triggerDay,
    };
    let nominal: NominalResult;
    switch (rule.dayCounting) {
      case "calendar":
        nominal = computeNominalEnd(nominalOptions);
        break;
      case "working":
        nominal =
          period.unit === DEADLINE_UNIT.DAY
            ? countWorkingDays(options)
            : computeNominalEnd(nominalOptions);
        break;
      default: {
        rule.dayCounting satisfies never;
        return panic("Unexpected day-counting policy.", rule.dayCounting);
      }
    }
    if (nominal.isErr()) {
      return nominal;
    }
    const nominalEnd = nominal.value;
    let end = nominalEnd;
    const shifts: DeadlineShift[] = [];
    const step = ADJUSTMENT_STEP[rule.endAdjustment];
    for (;;) {
      const classification = getNonWorkingReason({
        jurisdiction,
        date: end,
        rule,
        calendar,
      });
      if (classification.isErr()) {
        return classification;
      }
      if (step === 0 || !classification.value) {
        return Result.ok({
          end,
          nominalEnd,
          shifts,
          rule: { jurisdiction, source: rule.source },
        });
      }
      if (shifts.length === rule.limits.maxShiftDays) {
        return Result.err(
          new DeadlineError({
            message:
              "The calendar did not yield a working day within the adjustment limit.",
            reason: "adjustment_limit",
            jurisdiction,
            date: end.toString(),
          }),
        );
      }
      shifts.push({ date: end, reason: classification.value });
      const next = addCalendarDays(end, step);
      if (next.isErr()) {
        return next;
      }
      end = next.value;
    }
  };
