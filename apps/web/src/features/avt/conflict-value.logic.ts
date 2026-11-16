/**
 * What a record says on a conflict's disputed point, read for display. The
 * grader gives each value as text; a calendar date (`2021-08-10`, `2021-08`)
 * is shown through the locale's date format, anything else as written.
 */

import { Result } from "better-result";

import { Temporal } from "@stll/time";

import type { FactDatePrecision } from "@/features/avt/types";

export type ConflictValue =
  | { type: "date"; occurredOn: string; precision: FactDatePrecision }
  | { type: "text"; text: string };

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const MONTH = /^\d{4}-\d{2}$/u;

/** A real calendar date stored as its first day, the way fact dates are. */
const calendarDate = (iso: string): string | null =>
  Result.try(() =>
    Temporal.PlainDate.from(iso, { overflow: "reject" }).toString(),
  ).unwrapOr(null);

export const readConflictValue = (value: string): ConflictValue => {
  const text = value.trim();
  if (DAY.test(text)) {
    const occurredOn = calendarDate(text);
    if (occurredOn !== null) {
      return { type: "date", occurredOn, precision: "day" };
    }
  }
  if (MONTH.test(text)) {
    const occurredOn = calendarDate(`${text}-01`);
    if (occurredOn !== null) {
      return { type: "date", occurredOn, precision: "month" };
    }
  }
  return { type: "text", text: value };
};
