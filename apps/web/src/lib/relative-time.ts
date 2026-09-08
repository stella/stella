import { Result } from "better-result";

import { Temporal } from "@stll/time";

import { getFormatter, getFormattingLocale } from "@/i18n/i18n-store";

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;
const WEEK = 604_800;
const MONTH = 2_592_000;
const YEAR = 31_536_000;

const toInstant = (
  value: Date | string | Temporal.Instant,
): Temporal.Instant | null => {
  if (value instanceof Temporal.Instant) {
    return value;
  }
  if (value instanceof Date) {
    return Result.try(() =>
      Temporal.Instant.fromEpochMilliseconds(value.getTime()),
    ).unwrapOr(null);
  }
  return Result.try(() =>
    /^\d{4}-\d{2}-\d{2}$/u.test(value)
      ? Temporal.PlainDate.from(value)
          .toZonedDateTime({
            plainTime: Temporal.PlainTime.from("00:00"),
            timeZone: "UTC",
          })
          .toInstant()
      : Temporal.Instant.from(value),
  ).unwrapOr(null);
};

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
export const formatRelativeTime = (
  date: Date | string | Temporal.Instant,
): string => {
  const now = Temporal.Now.instant().epochMilliseconds;
  const then = toInstant(date)?.epochMilliseconds;
  if (then === undefined) {
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
  const resolvedDate = toInstant(date);
  if (resolvedDate === null) {
    return "";
  }

  return getFormatter().dateTime(resolvedDate.epochMilliseconds, {
    dateStyle: "full",
    timeStyle: "medium",
  });
};

type FormatContextualTimestampOptions = {
  date: Date | string;
  now?: Date | Temporal.Instant;
  today: (time: string) => string;
};

export const formatContextualTimestamp = ({
  date,
  now = Temporal.Now.instant(),
  today,
}: FormatContextualTimestampOptions): string => {
  const resolvedDate = toInstant(date);
  const resolvedNow = toInstant(now);
  if (resolvedDate === null || resolvedNow === null) {
    return "";
  }

  const formatter = getFormatter();
  const timeZone = Temporal.Now.timeZoneId();
  const localDate = resolvedDate.toZonedDateTimeISO(timeZone).toPlainDate();
  const localNowDate = resolvedNow.toZonedDateTimeISO(timeZone).toPlainDate();
  const isToday = Temporal.PlainDate.compare(localDate, localNowDate) === 0;

  if (isToday) {
    return today(
      formatter.dateTime(resolvedDate.epochMilliseconds, {
        timeStyle: "short",
      }),
    );
  }

  return formatter.dateTime(
    resolvedDate.epochMilliseconds,
    MEDIUM_DATE_SHORT_TIME_FORMAT,
  );
};

/** Whether `date` lies within the last `seconds`; false for an unparsable date. */
export const isWithinLast = (date: Date | string, seconds: number): boolean => {
  const then = toInstant(date)?.epochMilliseconds;
  if (then === undefined) {
    return false;
  }
  return Temporal.Now.instant().epochMilliseconds - then <= seconds * 1000;
};
