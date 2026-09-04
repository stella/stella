// Decision-date semantics: the publication-year bounds a case-law record has
// to fall within, and the UTC-addressed day helpers the ingestion cursors walk.
// The grammar and calendar checks these build on live in `@stll/time`, which
// both apps share.

import { isoDateParts, type IsoDateParts } from "@stll/time";

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
