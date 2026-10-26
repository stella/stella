import { Result } from "better-result";
import * as v from "valibot";

import { DAY_IN_MS, Temporal } from "@stll/time";

/** Delegated read capabilities backed by the user's Microsoft Graph grant. */
export const MICROSOFT365_CAPABILITIES = [
  "files.read",
  "calendar.read",
] as const;

export type Microsoft365Capability = (typeof MICROSOFT365_CAPABILITIES)[number];

export const MICROSOFT365_CALENDAR_RANGE_DAYS = 31;
export const MICROSOFT365_CALENDAR_TOTAL_CAP = 200;
export const MICROSOFT365_CALENDAR_ATTENDEE_CAP = 20;

export const microsoft365CalendarRangeEntries = {
  start: v.pipe(v.string(), v.maxLength(64), v.isoTimestamp()),
  end: v.pipe(v.string(), v.maxLength(64), v.isoTimestamp()),
};

// Timestamp arithmetic is enforced at runtime; JSON Schema has no keyword
// for the distance between two timestamp properties.
export const MICROSOFT365_CALENDAR_RUNTIME_ONLY_CHECKS = [
  v.check(({ start, end }: { start: string; end: string }) => {
    const range = Result.try(
      () =>
        Temporal.Instant.from(end).epochMilliseconds -
        Temporal.Instant.from(start).epochMilliseconds,
    );
    return (
      Result.isOk(range) &&
      range.value > 0 &&
      range.value <= MICROSOFT365_CALENDAR_RANGE_DAYS * DAY_IN_MS
    );
  }, `Use an increasing ISO timestamp range of at most ${MICROSOFT365_CALENDAR_RANGE_DAYS} days`),
] as const;
