// Evidential detail of a legal-list fact item: when it happened, what carries
// it, and how far its meaning can be relied on. AVT verifies claims against
// these facts; the vocabulary belongs to Lists because a fact's reliability
// does not depend on which feature reads it.

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

export const FACT_DETAIL_LIMITS = {
  EVIDENCE_KIND_MAX: 64,
  MEDIUM_MAX: 64,
  INTERPRETATION_NOTE_MAX: 4000,
} as const;
