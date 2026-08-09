import { LIMITS } from "@/api/lib/limits";

export const roundToBillingIncrement = (minutes: number): number => {
  const increment = LIMITS.billingIncrementMinutes;
  return Math.ceil(minutes / increment) * increment;
};
