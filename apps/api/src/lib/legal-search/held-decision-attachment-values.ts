import type { DecisionIdentifierType } from "@stll/legal-ast/decision-identifier";

/**
 * The states and match bases of a record that enriches a decision another
 * source holds (`case_law_held_decision_attachments`). The table's CHECKs
 * and the pipeline read these lists, so both sides are the same values.
 */

export const HELD_DECISION_ATTACHMENT_STATUS = {
  /** The record enriches the one held decision it names. */
  ATTACHED: "attached",
  /**
   * Several held decisions match the record. None is chosen and no row of
   * its own is written: a duplicate is worse than a gap. Parked until an
   * operator settles it.
   */
  AMBIGUOUS: "ambiguous",
  /**
   * The decision it enriched was erased or redacted. A takedown covers every
   * publisher's copy of the decision, so the record is parked and never
   * written as a decision of its own.
   */
  HOST_WITHDRAWN: "host-withdrawn",
} as const;

export type HeldDecisionAttachmentStatus =
  (typeof HELD_DECISION_ATTACHMENT_STATUS)[keyof typeof HELD_DECISION_ATTACHMENT_STATUS];

export const HELD_DECISION_ATTACHMENT_STATUSES = [
  HELD_DECISION_ATTACHMENT_STATUS.ATTACHED,
  HELD_DECISION_ATTACHMENT_STATUS.AMBIGUOUS,
  HELD_DECISION_ATTACHMENT_STATUS.HOST_WITHDRAWN,
] as const satisfies readonly HeldDecisionAttachmentStatus[];

/** What named the held decision. */
export const HELD_DECISION_MATCH_BASIS = {
  /** The record's stated ECLI, as one held decision's ECLI identifier. */
  ECLI: "ecli",
  /** The record's court, docket and decision date, as one held decision's. */
  COURT_DOCKET_DATE: "court-docket-date",
} as const;

export type HeldDecisionMatchBasis =
  (typeof HELD_DECISION_MATCH_BASIS)[keyof typeof HELD_DECISION_MATCH_BASIS];

export const HELD_DECISION_MATCH_BASES = [
  HELD_DECISION_MATCH_BASIS.ECLI,
  HELD_DECISION_MATCH_BASIS.COURT_DOCKET_DATE,
] as const satisfies readonly HeldDecisionMatchBasis[];

/**
 * One identifier row a record declared on its host, as written: the record
 * keeps the list so a changed observation can withdraw what it no longer
 * states.
 */
export type HeldDecisionDeclaredIdentifier = {
  type: DecisionIdentifierType;
  value: string;
  normalizedValue: string;
};

/**
 * Candidate decisions a parked ambiguous record names for its operator. The
 * match reads one more as a sentinel only when it needs to tell one from
 * several; an ambiguous record lists up to this many.
 */
export const HELD_DECISION_AMBIGUOUS_CANDIDATES_MAX = 8;
