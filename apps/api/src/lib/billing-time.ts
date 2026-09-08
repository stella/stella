import { panic } from "better-result";

import { parsePlainDate, Temporal } from "@stll/time";

import { LIMITS } from "@/api/lib/limits";

export const roundToBillingIncrement = (minutes: number): number => {
  const increment = LIMITS.billingIncrementMinutes;
  return Math.ceil(minutes / increment) * increment;
};

export const getTimeEntryDateValidationError = ({
  dateWorked,
  today,
}: {
  dateWorked: string;
  today: string;
}): string | null => {
  const workedDate = parsePlainDate(dateWorked);
  if (workedDate === null) {
    return "Date worked must be a valid calendar date";
  }
  const todayDate =
    parsePlainDate(today) ??
    panic("Current date must be a normalized ISO calendar date");

  if (Temporal.PlainDate.compare(workedDate, todayDate) > 0) {
    return "Date worked cannot be in the future";
  }

  const maxAgeCutoff = todayDate.subtract({
    days: LIMITS.timeEntryMaxAgeDays,
  });
  if (Temporal.PlainDate.compare(workedDate, maxAgeCutoff) < 0) {
    return `Date worked cannot be more than ${LIMITS.timeEntryMaxAgeDays} days ago`;
  }

  return null;
};
