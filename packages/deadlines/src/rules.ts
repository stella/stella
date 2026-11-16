import type { ComputeNominalEndOptions } from "./nominal-end";

export type IsoDayOfWeek = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type DeadlineRuleSet = {
  readonly triggerDay: NonNullable<ComputeNominalEndOptions["triggerDay"]>;
  readonly dayCounting: "calendar" | "working";
  readonly monthEnd: NonNullable<ComputeNominalEndOptions["monthEnd"]>;
  readonly endAdjustment: "next-working-day" | "previous-working-day" | "none";
  readonly courtHolidays: "ignore" | "observe";
  readonly weekendDays: readonly IsoDayOfWeek[];
  readonly limits: {
    readonly maxCountingDays: number;
    readonly maxShiftDays: number;
  };
  readonly source: string;
};

const calendarPeriodRule = {
  triggerDay: "exclude",
  dayCounting: "calendar",
  monthEnd: "constrain",
  endAdjustment: "next-working-day",
  courtHolidays: "ignore",
  weekendDays: [6, 7],
  limits: { maxCountingDays: 36_600, maxShiftDays: 31 },
} as const satisfies Omit<DeadlineRuleSet, "source">;

export const DEADLINE_RULES = {
  CZ: {
    ...calendarPeriodRule,
    source: "§ 57 zákona č. 99/1963 Sb.; § 40 zákona č. 500/2004 Sb.",
  },
  SK: {
    ...calendarPeriodRule,
    source: "§ 121 zákona č. 160/2015 Z. z.; § 27 zákona č. 71/1967 Zb.",
  },
} as const satisfies Record<string, DeadlineRuleSet>;

export type DeadlineJurisdiction = keyof typeof DEADLINE_RULES;
