import type { DecisionIdentifierType } from "@stll/legal-ast/decision-identifier";

/**
 * The match bases of a record that enriches a decision another source holds
 * (`case_law_held_decision_attachments`). The table's CHECK and the pipeline
 * read this list, so both sides are the same values.
 *
 * A record is attached when it names a host and that host is not withdrawn,
 * ambiguous when it names candidates and no host, and parked behind a
 * takedown once `host_withdrawn_at` is set. These are facts of the row, not
 * a stored status.
 */

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
