// parser-output-unchanged: [pl-uokik] new helper; no parser calls it.
import { Result } from "better-result";
import { Temporal } from "temporal-polyfill/full";

declare const timeZoneIdBrand: unique symbol;

/** An IANA time-zone id, spelled the way the runtime's tz database spells it. */
export type TimeZoneId = string & { readonly [timeZoneIdBrand]: true };

const FIXED_OFFSET = /^[+-]/u;
const EPOCH = Temporal.Instant.fromEpochMilliseconds(0);

const zoneSpelling = (value: string): string | null =>
  Result.try(() => EPOCH.toZonedDateTimeISO(value).timeZoneId).unwrapOr(null);

/** Temporal knows the zone and spells it exactly this way. */
const isTimeZoneId = (value: string): value is TimeZoneId =>
  !FIXED_OFFSET.test(value) && zoneSpelling(value) === value;

/**
 * Read an IANA time-zone id (`Europe/Prague`, `America/New_York`, `UTC`) the
 * way the runtime's tz database spells it, or `null` when it does not know it.
 *
 * Spellings with one meaning are normalized: surrounding whitespace and letter
 * case (`europe/prague` reads as `Europe/Prague`). A fixed UTC offset
 * (`+01:00`) is refused although Temporal accepts one: it never observes
 * daylight saving time, so a stored offset would move every "today" by an
 * hour for half of the year.
 */
export const parseTimeZoneId = (value: string): TimeZoneId | null => {
  const candidate = value.trim();
  if (candidate === "" || FIXED_OFFSET.test(candidate)) {
    return null;
  }
  const spelling = zoneSpelling(candidate);
  return spelling !== null && isTimeZoneId(spelling) ? spelling : null;
};
