import { parsePlainDate } from "@stll/time";

// Billing dates (date worked, date incurred, invoice and due dates) are plain
// calendar dates. They are formatted as UTC midnight with `timeZone: "UTC"`,
// so the reader's own time zone never shifts the day.

/** A plain date (`YYYY-MM-DD`) as epoch milliseconds at UTC midnight. */
export const plainDateEpoch = (date: string) =>
  parsePlainDate(date)?.toZonedDateTime("UTC").epochMilliseconds ?? 0;

export const SHORT_DATE = {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
} as const satisfies Intl.DateTimeFormatOptions;

export const MEDIUM_DATE = {
  dateStyle: "medium",
  timeZone: "UTC",
} as const satisfies Intl.DateTimeFormatOptions;
