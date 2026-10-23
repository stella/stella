import * as v from "valibot";

import { parsePlainDate, Temporal } from "@stll/time";

/** PostgreSQL-backed API dates use four-digit CE years, without a timezone. */
export const isApiDate = (value: string): boolean => {
  const date = parsePlainDate(value);
  return date !== null && date.year > 0;
};

// PostgreSQL `timestamptz` stores UTC years 0001 to 9999 as API values; an
// offset can move a written year 0001 or 9999 instant outside that range.
const STORABLE_FROM_MS = Temporal.Instant.from(
  "0001-01-01T00:00:00Z",
).epochMilliseconds;
const STORABLE_UNTIL_MS = Temporal.Instant.from(
  "+010000-01-01T00:00:00Z",
).epochMilliseconds;

/** Whether an already well-formed date-time names an instant the API stores. */
export const isStorableInstant = (value: string): boolean => {
  const epochMs = new Date(value).getTime();
  return epochMs >= STORABLE_FROM_MS && epochMs < STORABLE_UNTIL_MS;
};

const apiDateCheck = v.check(
  isApiDate,
  "Expected an existing calendar day as YYYY-MM-DD in years 0001 to 9999",
);

/**
 * Model providers read published schemas with differing regex dialects, so the
 * calendar check stays out of JSON Schema; `format: "date"` is published.
 */
export const API_DATE_RUNTIME_ONLY_CHECKS = [apiDateCheck] as const;

/** The Valibot form of the strict `date` format: MCP inputs and model output. */
export const vApiDate = v.pipe(v.string(), v.isoDate(), apiDateCheck);
