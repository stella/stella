import * as v from "valibot";

import { parsePlainDate, Temporal } from "@stll/time";

/** API calendar dates use four-digit CE years, without a timezone. */
export const isApiDate = (value: string): boolean => {
  const date = parsePlainDate(value);
  return date !== null && date.year > 0;
};

/**
 * The calendar check `v.isoDate()` leaves out: its pattern admits days that
 * do not exist (`2026-02-30`) and year zero. JSON Schema states the shape
 * (`format: "date"`); this check runs on every parse. Every `v.isoDate()` in
 * an API schema is followed by it, which a census over the served schemas
 * holds.
 */
export const API_CALENDAR_DATE_CHECK = v.check(
  isApiDate,
  "Expected an existing calendar day as YYYY-MM-DD in years 0001 to 9999",
);

/** The strict calendar-date boundary shared by API, desktop and MCP inputs. */
export const apiDateSchema = v.pipe(
  v.string(),
  v.isoDate(),
  API_CALENDAR_DATE_CHECK,
);

// API instants retain UTC years 0001 to 9999 in their serialized form.
const STORABLE_FROM_MS = Temporal.Instant.from(
  "0001-01-01T00:00:00Z",
).epochMilliseconds;
const STORABLE_UNTIL_MS = Temporal.Instant.from(
  "+010000-01-01T00:00:00Z",
).epochMilliseconds;

/** Whether the raw date-time directly parses to an instant the API stores. */
export const isStorableInstant = (value: string): boolean => {
  const epochMs = new Date(value).getTime();
  return epochMs >= STORABLE_FROM_MS && epochMs < STORABLE_UNTIL_MS;
};

/**
 * The instant check `v.isoTimestamp()` leaves out: its pattern admits year
 * zero, offsets that move the instant out of years 0001 to 9999, and
 * spellings `Date` cannot parse. JSON Schema states the shape
 * (`format: "date-time"`); this check runs on every parse, and the same
 * census holds it after every `v.isoTimestamp()`.
 */
export const API_STORABLE_INSTANT_CHECK = v.check(
  isStorableInstant,
  "Expected an ISO 8601 date-time within UTC years 0001 to 9999",
);

/** An API instant (ISO 8601 date-time), read or answered. */
export const apiDateTimeSchema = v.pipe(
  v.string(),
  v.isoTimestamp(),
  API_STORABLE_INSTANT_CHECK,
);

/** Checks that run only at parse; published schemas keep the plain format. */
export const API_DATE_RUNTIME_ONLY_CHECKS = [
  API_CALENDAR_DATE_CHECK,
  API_STORABLE_INSTANT_CHECK,
] as const;
