import { Result } from "better-result";
import { Temporal } from "temporal-polyfill/full";

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * True when `value` has the `YYYY-MM-DD` shape. This guard does not check
 * whether the date exists; use `parsePlainDate` for calendar validation.
 */
export const isIsoDateString = (value: string): boolean =>
  ISO_DATE_PATTERN.test(value);

/** A real ISO calendar day, independent of the host timezone. */
export const parsePlainDate = (value: string): Temporal.PlainDate | null => {
  if (!isIsoDateString(value)) {
    return null;
  }
  return Result.try(() => Temporal.PlainDate.from(value)).unwrapOr(null);
};

/**
 * Parse a `YYYY-MM-DD` calendar date at local midnight.
 *
 * A date-only `Date` string is UTC, which renders as the previous day west of
 * UTC. This resolves the day through Temporal in the runtime's timezone, then
 * adapts the resulting instant to `Date`. Malformed, nonexistent, and locally
 * skipped calendar days return `null`.
 */
export const parseIsoDateLocal = (value: string): Date | null => {
  const plainDate = parsePlainDate(value);
  if (plainDate === null) {
    return null;
  }

  const zonedDate = plainDate.toZonedDateTime(Temporal.Now.timeZoneId());

  // A local `Date` cannot represent a calendar day a timezone skipped, such
  // as 2011-12-30 in Pacific/Apia. Keep this adapter's nullable contract while
  // `parsePlainDate` remains valid for calendar-only work in every timezone.
  if (!zonedDate.toPlainDate().equals(plainDate)) {
    return null;
  }
  return new Date(zonedDate.epochMilliseconds);
};

/**
 * Add `n` calendar days to `date`, DST-safe.
 *
 * Adding `n * 24 * 60 * 60 * 1000` milliseconds breaks across a DST
 * transition: the transition day is 23 or 25 hours, so a fixed 24h step
 * over- or under-shoots the intended calendar day. Temporal adds calendar
 * days in the runtime's timezone while preserving local wall-clock time.
 */
export const addDays = (date: Date, n: number): Date => {
  const zonedDate = Temporal.Instant.fromEpochMilliseconds(
    date.getTime(),
  ).toZonedDateTimeISO(Temporal.Now.timeZoneId());
  return new Date(zonedDate.add({ days: n }).epochMilliseconds);
};
