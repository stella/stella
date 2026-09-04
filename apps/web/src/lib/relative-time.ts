import { getFormatter, getFormattingLocale } from "@/i18n/i18n-store";

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;
const WEEK = 604_800;
const MONTH = 2_592_000;
const YEAR = 31_536_000;

export const MEDIUM_DATE_SHORT_TIME_FORMAT = {
  dateStyle: "medium",
  timeStyle: "short",
} as const satisfies Intl.DateTimeFormatOptions;

export const FULL_DATE_LONG_TIME_FORMAT = {
  dateStyle: "full",
  timeStyle: "long",
} as const satisfies Intl.DateTimeFormatOptions;

/** "5 Mar" — a day whose year the surrounding view already establishes. */
export const DAY_AND_MONTH_FORMAT = {
  month: "short",
  day: "numeric",
} as const satisfies Intl.DateTimeFormatOptions;

/** "5 Mar 2026" — a day that has to carry its own year. */
export const CALENDAR_DATE_FORMAT = {
  month: "short",
  day: "numeric",
  year: "numeric",
} as const satisfies Intl.DateTimeFormatOptions;

/**
 * A date-only value, read back in the timezone it was written in. Rendering a
 * stored calendar day in the reader's own timezone moves it by a day for every
 * reader west of UTC.
 */
export const UTC_CALENDAR_DATE_FORMAT = {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
} as const satisfies Intl.DateTimeFormatOptions;

/** The locale's medium date, for a timestamp that carries a real instant. */
export const MEDIUM_DATE_FORMAT = {
  dateStyle: "medium",
} as const satisfies Intl.DateTimeFormatOptions;

/** The medium date of a date-only value; see `UTC_CALENDAR_DATE_FORMAT`. */
export const UTC_MEDIUM_DATE_FORMAT = {
  dateStyle: "medium",
  timeZone: "UTC",
} as const satisfies Intl.DateTimeFormatOptions;

/** "Monday" — a weekday named in running text. */
export const WEEKDAY_NAME_FORMAT = {
  weekday: "long",
} as const satisfies Intl.DateTimeFormatOptions;

/** "M" — a weekday heading a column that fits one glyph. */
export const WEEKDAY_INITIAL_FORMAT = {
  weekday: "narrow",
} as const satisfies Intl.DateTimeFormatOptions;

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

  return getFormatter().dateTime(resolvedDate, {
    dateStyle: "full",
    timeStyle: "medium",
  });
};

type FormatContextualTimestampOptions = {
  date: Date | string;
  now?: Date;
  today: (time: string) => string;
};

export const formatContextualTimestamp = ({
  date,
  now = new Date(),
  today,
}: FormatContextualTimestampOptions): string => {
  const resolvedDate = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(resolvedDate.getTime())) {
    return "";
  }

  const formatter = getFormatter();
  const isToday =
    resolvedDate.getFullYear() === now.getFullYear() &&
    resolvedDate.getMonth() === now.getMonth() &&
    resolvedDate.getDate() === now.getDate();

  if (isToday) {
    return today(formatter.dateTime(resolvedDate, { timeStyle: "short" }));
  }

  return formatter.dateTime(resolvedDate, MEDIUM_DATE_SHORT_TIME_FORMAT);
};

/** Whether `date` lies within the last `seconds`; false for an unparsable date. */
export const isWithinLast = (date: Date | string, seconds: number): boolean => {
  const then =
    typeof date === "string" ? new Date(date).getTime() : date.getTime();
  if (Number.isNaN(then)) {
    return false;
  }
  return Date.now() - then <= seconds * 1000;
};
