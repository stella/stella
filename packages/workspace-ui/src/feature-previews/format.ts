import { Temporal } from "temporal-polyfill/full";

// Scenes are static: every date and time is a fixed calendar value, so the
// output is identical between renders and never reads the ambient clock or
// time zone. Only the locale that formats them varies.

type FormatPreviewDateParams = {
  locale: string;
  /** `YYYY-MM-DD`. */
  date: string;
  options: Intl.DateTimeFormatOptions;
};

export const formatPreviewDate = ({
  locale,
  date,
  options,
}: FormatPreviewDateParams): string =>
  Temporal.PlainDate.from(date).toLocaleString(locale, options);

/** A wall-clock time (`HH:MM`) in the locale's own hour cycle. */
export const formatPreviewTime = (locale: string, time: string): string =>
  Temporal.PlainTime.from(time).toLocaleString(locale, {
    hour: "numeric",
    minute: "2-digit",
  });

/** Minutes as `h:mm`, the way a timesheet shows a duration. */
export const formatPreviewDuration = (
  locale: string,
  totalMinutes: number,
): string => {
  const hours = new Intl.NumberFormat(locale).format(
    Math.floor(totalMinutes / 60),
  );
  const minutes = new Intl.NumberFormat(locale, {
    minimumIntegerDigits: 2,
  }).format(totalMinutes % 60);
  return `${hours}:${minutes}`;
};

/** Minutes as decimal hours, the way an invoice bills them. */
export const formatPreviewHours = (
  locale: string,
  totalMinutes: number,
): string =>
  new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 2,
  }).format(totalMinutes / 60);

export const formatPreviewCount = (locale: string, count: number): string =>
  new Intl.NumberFormat(locale).format(count);
