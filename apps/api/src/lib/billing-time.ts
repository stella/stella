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
  const workedDate = new Date(`${dateWorked}T00:00:00`);
  const todayDate = new Date(`${today}T00:00:00`);

  if (workedDate > todayDate) {
    return "Date worked cannot be in the future";
  }

  const maxAgeCutoff = new Date(todayDate);
  maxAgeCutoff.setDate(maxAgeCutoff.getDate() - LIMITS.timeEntryMaxAgeDays);
  if (workedDate < maxAgeCutoff) {
    return `Date worked cannot be more than ${LIMITS.timeEntryMaxAgeDays} days ago`;
  }

  return null;
};
