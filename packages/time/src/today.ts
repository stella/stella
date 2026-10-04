// parser-output-unchanged: [pl-uokik] new helper; no parser calls it.
import { Temporal } from "temporal-polyfill/full";

/**
 * The calendar day a person in `zone` sees at `at` (now when omitted).
 *
 * A user-facing "today" is a property of a time zone, never of the server's
 * clock: the UTC day is the previous calendar day for the first hours after
 * local midnight east of UTC, and the next one in the evening west of it. Every
 * "today", "this month" and "is it closed yet" decision takes the zone of the
 * person or organization it is shown to, and reads the day here.
 *
 * `zone` is an IANA time-zone id (`Europe/Prague`); an unknown id throws, as
 * Temporal does, because guessing a zone would move the day silently.
 */
export const todayFor = (
  zone: string,
  at: Temporal.Instant = Temporal.Now.instant(),
): Temporal.PlainDate => at.toZonedDateTimeISO(zone).toPlainDate();
