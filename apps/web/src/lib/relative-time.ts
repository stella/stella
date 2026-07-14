import { getFormattingLocale } from "@/i18n/i18n-store";

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;
const WEEK = 604_800;
const MONTH = 2_592_000;
const YEAR = 31_536_000;

const relativeTimeFormatters = new Map<string, Intl.RelativeTimeFormat>();

/** `Intl.RelativeTimeFormat` for `locale`, cached per locale so it isn't
 *  rebuilt on every `formatRelativeTime` call. */
export const getRelativeTimeFormatter = (
  locale: string,
): Intl.RelativeTimeFormat => {
  const cached = relativeTimeFormatters.get(locale);
  if (cached) {
    return cached;
  }

  const formatter = new Intl.RelativeTimeFormat(locale, {
    numeric: "auto",
    style: "narrow",
  });
  relativeTimeFormatters.set(locale, formatter);
  return formatter;
};

/**
 * Format a date as a relative time string using
 * `Intl.RelativeTimeFormat`. Returns short forms like
 * "2h ago", "yesterday", "3d ago".
 */
export const formatRelativeTime = (date: Date | string): string => {
  const now = Date.now();
  const then =
    typeof date === "string" ? new Date(date).getTime() : date.getTime();
  if (Number.isNaN(then)) {
    return "";
  }
  const diff = Math.round((then - now) / 1000);
  const absDiff = Math.abs(diff);

  const rtf = getRelativeTimeFormatter(getFormattingLocale());

  if (absDiff < MINUTE) {
    // "just now" / "1 min. ago" — sub-minute precision is noise
    return rtf.format(0, "minute");
  }
  if (absDiff < HOUR) {
    return rtf.format(Math.trunc(diff / MINUTE), "minute");
  }
  if (absDiff < DAY) {
    return rtf.format(Math.trunc(diff / HOUR), "hour");
  }
  if (absDiff < WEEK) {
    return rtf.format(Math.trunc(diff / DAY), "day");
  }
  if (absDiff < MONTH) {
    return rtf.format(Math.trunc(diff / WEEK), "week");
  }
  if (absDiff < YEAR) {
    return rtf.format(Math.trunc(diff / MONTH), "month");
  }
  return rtf.format(Math.trunc(diff / YEAR), "year");
};

export const formatFullTimestamp = (date: Date | string): string => {
  const resolvedDate = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(resolvedDate.getTime())) {
    return "";
  }

  return resolvedDate.toLocaleString(getFormattingLocale(), {
    dateStyle: "full",
    timeStyle: "medium",
  });
};
