import * as v from "valibot";

import { parsePlainDate } from "@stll/time";

/** PostgreSQL-backed API dates use four-digit CE years, without a timezone. */
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
  "Expected an existing calendar date (YYYY-MM-DD).",
);

/** An API calendar date (`YYYY-MM-DD`), read or answered. */
export const apiDateSchema = v.pipe(
  v.string(),
  v.isoDate(),
  API_CALENDAR_DATE_CHECK,
);
