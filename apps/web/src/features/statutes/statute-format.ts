import type { createFormatter } from "use-intl/core";

import { parseDeterministicDate } from "@/lib/deterministic-date";

type IntlFormatter = ReturnType<typeof createFormatter>;

export const EM_DASH = "—";

/** Date-only validity boundary, rendered in the reader's locale. */
export const formatValidityDate = (
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
