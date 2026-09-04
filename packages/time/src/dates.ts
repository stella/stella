// Guards against the two most common date footguns: UTC/local-midnight drift
// when parsing a bare calendar-date string, and DST-unsafe day arithmetic via
// millisecond math. Both apps parsed and stepped calendar dates with their own
// copy of this; the copies agreed, which is exactly why one of them could have
// drifted unnoticed.

const ISO_DATE_PATTERN = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/u;

/**
 * True when `value` has the `YYYY-MM-DD` shape `parseIsoDateLocal` accepts.
 * Does not check that the date exists on the calendar (e.g. "2024-02-30"
 * passes this guard but `parseIsoDateLocal` still rejects it).
 */
export const isIsoDateString = (value: string): boolean =>
  ISO_DATE_PATTERN.test(value);

/**
 * Parse a `YYYY-MM-DD` calendar-date string as LOCAL midnight.
 *
 * `new Date("2024-01-01")` parses as UTC midnight per the ECMAScript spec;
 * rendering it in any timezone west of UTC (e.g. US, most of the Americas)
 * shows the previous day. This builds the `Date` from the individual parts
 * instead, so it always lands on the intended calendar day in the local
 * timezone.
 *
 * Returns `null` for a malformed string or a day/month that does not exist
 * on the calendar, instead of silently rolling over (e.g. "2024-02-30").
 */
export type IsoDateParts = {
  year: number;
  month: number;
  day: number;
};

/**
 * Numeric parts of a `YYYY-MM-DD` string, or `null` when it does not have
 * that shape. Says nothing about whether the parts name a real calendar day;
 * the two callers below check that in the calendar each of them means.
 */
export const isoDateParts = (value: string): IsoDateParts | null => {
  const groups = ISO_DATE_PATTERN.exec(value)?.groups;
  const yearStr = groups?.["year"];
  const monthStr = groups?.["month"];
  const dayStr = groups?.["day"];
  if (!yearStr || !monthStr || !dayStr) {
    return null;
  }
  return {
    year: Number(yearStr),
    month: Number(monthStr),
    day: Number(dayStr),
  };
};

export const parseIsoDateLocal = (value: string): Date | null => {
  const parts = isoDateParts(value);
  if (parts === null) {
    return null;
  }

  const { year, month, day } = parts;
  const date = new Date(year, month - 1, day);

  // `Date` rolls over out-of-range parts (e.g. Feb 30 -> Mar 2) instead of
  // throwing; reject anything that didn't round-trip to the input date.
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
};

/**
 * Add `n` calendar days to `date`, DST-safe.
 *
 * Adding `n * 24 * 60 * 60 * 1000` milliseconds breaks across a DST
 * transition: the transition day is 23 or 25 hours, so a fixed 24h step
 * over- or under-shoots the intended calendar day. This adds to the
 * day-of-month part instead and lets `Date` resolve the wall-clock time,
 * so the result always lands on the correct calendar date `n` days later.
 */
export const addDays = (date: Date, n: number): Date => {
  const result = new Date(date);
  result.setDate(result.getDate() + n);
  return result;
};
