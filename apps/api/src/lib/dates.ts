// Small, dependency-free guards against the two most common date footguns:
// UTC/local-midnight drift when parsing a bare calendar-date string, and
// DST-unsafe day arithmetic via millisecond math. See the mirrored
// `apps/web/src/lib/dates.ts` for the frontend-side copy — there is no
// shared cross-app package for this yet, so the two stay independent.

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
type IsoDateParts = {
  year: number;
  month: number;
  day: number;
};

/**
 * Numeric parts of a `YYYY-MM-DD` string, or `null` when it does not have
 * that shape. Says nothing about whether the parts name a real calendar day;
 * the two callers below check that in the calendar each of them means.
 */
const isoDateParts = (value: string): IsoDateParts | null => {
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

/** Length of the `YYYY-MM-DD` prefix a decision date is canonicalized to. */
const ISO_DATE_LENGTH = 10;

/**
 * Range a decision date may fall in. The floor year predates any court whose
 * decisions are published as machine-readable records, so a lower year is a
 * transcription or parsing artifact rather than a real date. The ceiling is
 * the current UTC day plus `daysAhead`: a decision cannot have been issued in
 * the future, and one calendar day of slack covers a court whose local date is
 * already ahead of UTC when it publishes. Anything later is a parsing
 * artifact, and a newest-first list would show it first.
 *
 * Exported because the same bounds have to hold in SQL:
 * `decision-date-bounds-sql.ts` derives the table's CHECK constraint and the
 * repair predicate from this declaration rather than restating the numbers.
 */
export const DECISION_DATE_BOUNDS = {
  minYear: 1800,
  daysAhead: 1,
} as const;

/**
 * An ISO time of day following a date: `T` or a space, then a bounded hour
 * and minute, optionally seconds, a fractional part and a zone offset.
 *
 * The time itself is never read. Matching it is how a value that merely
 * starts like a date ("2024-03-05Tgarbage", "2024-03-05T25:99:99Z") is told
 * apart from a real datetime, rather than having its first ten characters
 * taken on faith.
 */
const ISO_TIME_SUFFIX_PATTERN =
  /^[T ](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?$/u;

/**
 * The `YYYY-MM-DD` prefix of a bare calendar date or of a full ISO datetime,
 * or `null` when `raw` is neither shape.
 */
const isoDatePrefix = (raw: string): string | null => {
  if (raw.length === ISO_DATE_LENGTH) {
    return raw;
  }
  if (!ISO_TIME_SUFFIX_PATTERN.test(raw.slice(ISO_DATE_LENGTH))) {
    return null;
  }
  return raw.slice(0, ISO_DATE_LENGTH);
};

/**
 * True when the parts name a day that exists on the Gregorian calendar.
 *
 * Checked with UTC fields: a local-time `Date` also rejects a day the host's
 * timezone skipped (Pacific/Apia has no 2011-12-30, having crossed the date
 * line), which would make the same record acceptable or not depending on
 * where the code runs. UTC skips no days.
 */
const isUtcCalendarDay = ({ year, month, day }: IsoDateParts): boolean => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
};

/**
 * The `YYYY-MM-DD` form of a bare calendar date or of an ISO datetime whose
 * date part names a real Gregorian day, or `null` when it is neither.
 *
 * The grammar and calendar check on their own, without the publication-year
 * bounds `canonicalDecisionDate` adds: `"2024-02-30"` and `"01/02/2024"` are
 * rejected here, a year of 1200 is not. For callers that need a real day but
 * carry no decision semantics.
 */
export const isoCalendarDay = (raw: string): string | null => {
  const candidate = isoDatePrefix(raw);
  if (candidate === null) {
    return null;
  }
  const parts = isoDateParts(candidate);
  if (parts === null || !isUtcCalendarDay(parts)) {
    return null;
  }
  return candidate;
};

/**
 * Canonical `YYYY-MM-DD` form of a published decision date, or `null` when
 * the value cannot be one.
 *
 * Accepts a bare calendar date or an ISO datetime, and rejects anything that
 * is not a real calendar day (e.g. "2024-02-30") or that falls outside
 * `DECISION_DATE_BOUNDS`. A date column takes a malformed year or a future
 * day as readily as a correct one, so callers writing to one need this in
 * front of the write.
 */
export const canonicalDecisionDate = (raw: string): string | null => {
  const candidate = isoCalendarDay(raw);
  if (candidate === null) {
    return null;
  }
  const year = Number(candidate.slice(0, 4));
  if (year < DECISION_DATE_BOUNDS.minYear) {
    return null;
  }
  // ISO dates compare correctly as text, and the ceiling is a UTC day so the
  // host's time zone cannot move it.
  const ceiling = toUtcDateString(
    addUtcDays(new Date(), DECISION_DATE_BOUNDS.daysAhead),
  );
  if (candidate > ceiling) {
    return null;
  }
  return candidate;
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

/** Add calendar days using UTC fields, for UTC-backed date cursors. */
export const addUtcDays = (date: Date, n: number): Date => {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + n);
  return result;
};

/**
 * The UTC calendar day an instant falls on, as `YYYY-MM-DD`.
 *
 * The counterpart to `addUtcDays` for cursors and slice keys addressed in
 * UTC: both sides of a day walk have to agree on where a day starts, and a
 * local-calendar rendering of the same instant does not.
 */
export const toUtcDateString = (date: Date): string =>
  date.toISOString().slice(0, ISO_DATE_LENGTH);
