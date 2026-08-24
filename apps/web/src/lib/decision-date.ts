import type { createFormatter } from "use-intl/core";

import { parseDeterministicDate } from "@/lib/deterministic-date";

type IntlFormatter = ReturnType<typeof createFormatter>;

/** A legal decision date as a medium date in UTC, or null when none is stored. */
export const formatDecisionDate = (
  value: Date | string | null,
  format: IntlFormatter,
): string | null => {
  if (value === null) {
    return null;
  }
  const date = parseDeterministicDate(value);
  return date === null
    ? null
    : format.dateTime(date, { dateStyle: "medium", timeZone: "UTC" });
};
