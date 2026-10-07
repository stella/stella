import { Temporal, todayFor } from "@stll/time";

/**
 * The viewer's time zone: the zone the browser resolves, which is also the
 * zone the app formats dates and times in (`resolveAppTimeZone`). No other
 * user time-zone preference exists, so this is the zone a user-facing "today"
 * is read in.
 */
const viewerTimeZone = (): string => Temporal.Now.timeZoneId();

/** The viewer's calendar day now. */
export const appToday = (): Temporal.PlainDate => todayFor(viewerTimeZone());

/** The viewer's calendar day at `date` (now when omitted), as `YYYY-MM-DD`. */
export const localISODate = (date?: Date): string =>
  todayFor(
    viewerTimeZone(),
    date === undefined
      ? Temporal.Now.instant()
      : Temporal.Instant.fromEpochMilliseconds(date.getTime()),
  ).toString();
