import { Temporal } from "@stll/time";

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
