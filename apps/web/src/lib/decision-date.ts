import type { createFormatter } from "use-intl/core";

import { parseDeterministicDate } from "@/lib/deterministic-date";

type IntlFormatter = ReturnType<typeof createFormatter>;

/** A decision's calendar date as the API's point-in-time query value. */
export const decisionDateToIso = (
  value: Date | string | null,
): string | null => {
  if (value === null) {
    return null;
  }
  const date = parseDeterministicDate(value);
  return date === null ? null : date.toISOString().slice(0, 10);
};

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
