// Decision-date semantics: the publication-year bounds a case-law record has
// to fall within, and the UTC-addressed day helpers the ingestion cursors walk.
// The grammar and calendar checks these build on live in `@stll/time`, which
// both apps share.

import { parsePlainDate, Temporal } from "@stll/time";

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

const plainCalendarDay = (raw: string): Temporal.PlainDate | null => {
  const candidate = isoDatePrefix(raw);
  return candidate === null ? null : parsePlainDate(candidate);
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
  const candidate = plainCalendarDay(raw);
  return candidate?.toString() ?? null;
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
  const candidate = plainCalendarDay(raw);
  if (candidate === null) {
    return null;
  }
  if (candidate.year < DECISION_DATE_BOUNDS.minYear) {
    return null;
  }
  const ceiling = Temporal.Now.plainDateISO("UTC").add({
    days: DECISION_DATE_BOUNDS.daysAhead,
  });
  if (Temporal.PlainDate.compare(candidate, ceiling) > 0) {
    return null;
  }
  return candidate.toString();
};

const utcPlainDate = (date: Date): Temporal.PlainDate =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime())
    .toZonedDateTimeISO("UTC")
    .toPlainDate();

/** Add calendar days using UTC fields, for UTC-backed date cursors. */
export const addUtcDays = (date: Date, n: number): Date => {
  const zonedDate = Temporal.Instant.fromEpochMilliseconds(
    date.getTime(),
  ).toZonedDateTimeISO("UTC");
  return new Date(zonedDate.add({ days: n }).epochMilliseconds);
};

/**
 * The UTC calendar day an instant falls on, as `YYYY-MM-DD`.
 *
 * The counterpart to `addUtcDays` for cursors and slice keys addressed in
 * UTC: both sides of a day walk have to agree on where a day starts, and a
 * local-calendar rendering of the same instant does not.
 */
export const toUtcDateString = (date: Date): string =>
  utcPlainDate(date).toString();
