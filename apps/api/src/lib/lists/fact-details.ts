// Evidential detail of a legal-list fact item: when it happened, what carries
// it, and how far its meaning can be relied on. AVT verifies claims against
// these facts; the vocabulary belongs to Lists because a fact's reliability
// does not depend on which feature reads it.

import { panic } from "better-result";
import * as v from "valibot";

import { apiDateSchema } from "@stll/api-contract/api-date";

/** How unambiguous a fact's meaning is. Interpretive, never derived from the
 *  carrier medium (a handwritten note can be `high`). */
export const FACT_CONFIDENCES = ["high", "medium", "low"] as const;
export type FactConfidence = (typeof FACT_CONFIDENCES)[number];

/** Whether verdicts may rest on a fact. `held` keeps it out of scoring until
 *  a reviewer confirms it. */
export const FACT_SCORING = ["included", "held"] as const;
export type FactScoring = (typeof FACT_SCORING)[number];

/** How much of `occurredOn` is known: `2021-07-01` at `month` is July 2021. */
export const FACT_DATE_PRECISIONS = ["day", "month", "year"] as const;
export type FactDatePrecision = (typeof FACT_DATE_PRECISIONS)[number];

/** A date and how much of it is known, stored as its first day. */
export type PartialDate = { date: string; precision: FactDatePrecision };

export const FACT_DETAIL_LIMITS = {
  EVIDENCE_KIND_MAX: 64,
  MEDIUM_MAX: 64,
  INTERPRETATION_NOTE_MAX: 4000,
} as const;

/** A partial date has one spelling: its first day. */
export const canonicalFactDate = (
  date: string,
  precision: FactDatePrecision,
): string => {
  switch (precision) {
    case "day": {
      return date;
    }
    case "month": {
      return `${date.slice(0, 7)}-01`;
    }
    case "year": {
      return `${date.slice(0, 4)}-01-01`;
    }
    default: {
      precision satisfies never;
      return panic(`Unhandled date precision: ${String(precision)}`);
    }
  }
};

const PARTIAL_DATE_SHAPE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/u;

/** A date written `YYYY-MM-DD`, `YYYY-MM` or `YYYY`, at the precision it is
 *  written, or null when it is not a real calendar date. */
export const parsePartialDate = (value: string | null): PartialDate | null => {
  const match = value === null ? null : PARTIAL_DATE_SHAPE.exec(value.trim());
  if (!match) {
    return null;
  }
  const [, year, month, day] = match;
  let precision: FactDatePrecision = "day";
  if (month === undefined) {
    precision = "year";
  } else if (day === undefined) {
    precision = "month";
  }
  const date = `${year ?? ""}-${month ?? "01"}-${day ?? "01"}`;
  return v.is(apiDateSchema, date) ? { date, precision } : null;
};
