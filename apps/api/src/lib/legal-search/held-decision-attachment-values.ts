import { panic } from "better-result";

import type { DecisionIdentifierType } from "@stll/legal-ast/decision-identifier";

/**
 * The match bases of a record that enriches a decision another source holds
 * (`case_law_held_decision_attachments`). The table's CHECK and the pipeline
 * read this list, so both sides are the same values.
 *
 * A record is attached when it names a host and that host is not withdrawn,
 * parked for review when it names no host (`heldDecisionReviewOf` says why,
 * from its basis), and parked behind a takedown once `host_withdrawn_at` is
 * set. These are facts of the row, not a stored status.
 */

/** What named the held decision. */
export const HELD_DECISION_MATCH_BASIS = {
  /** The record's stated ECLI, as one held decision's ECLI identifier. */
  ECLI: "ecli",
  /** The record's court, docket and decision date, as one held decision's. */
  COURT_DOCKET_DATE: "court-docket-date",
  /**
   * The record's court and docket, held under another decision date. Never
   * attaches: the record is parked for review, since it is either a further
   * decision of the same case file or the same decision dated differently by
   * one of the publishers, and neither a duplicate nor a lost decision is
   * acceptable without a reader's look.
   */
  COURT_DOCKET_OTHER_DATE: "court-docket-other-date",
  SOURCE_POLICY: "source-policy",
} as const;

export type HeldDecisionMatchBasis =
  (typeof HELD_DECISION_MATCH_BASIS)[keyof typeof HELD_DECISION_MATCH_BASIS];

export const HELD_DECISION_MATCH_BASES = [
  HELD_DECISION_MATCH_BASIS.ECLI,
  HELD_DECISION_MATCH_BASIS.COURT_DOCKET_DATE,
  HELD_DECISION_MATCH_BASIS.COURT_DOCKET_OTHER_DATE,
  HELD_DECISION_MATCH_BASIS.SOURCE_POLICY,
] as const satisfies readonly HeldDecisionMatchBasis[];

/** The bases that can name a host; the other parks the record for review. */
export const HELD_DECISION_ATTACHING_BASES = [
  HELD_DECISION_MATCH_BASIS.ECLI,
  HELD_DECISION_MATCH_BASIS.COURT_DOCKET_DATE,
] as const satisfies readonly HeldDecisionMatchBasis[];

export type HeldDecisionAttachingBasis =
  (typeof HELD_DECISION_ATTACHING_BASES)[number];

/** Why a parked record waits for a reader instead of attaching or being written. */
export const HELD_DECISION_REVIEW = {
  /** Several held decisions match it, by ECLI or by court, docket and date. */
  SEVERAL_HELD: "several-held",
  /** Its court and docket are held, under another decision date. */
  DOCKET_HELD_OTHER_DATE: "docket-held-other-date",
  SOURCE_POLICY: "source-policy",
} as const;

export type HeldDecisionReview =
  (typeof HELD_DECISION_REVIEW)[keyof typeof HELD_DECISION_REVIEW];

/**
 * The review a stored attachment row waits for, or null for one that names
 * its host (attached, or parked behind the host's takedown). Read from the
 * row's facts: a row without a host is parked, and its basis says why.
 */
export const heldDecisionReviewOf = ({
  hostDecisionId,
  matchBasis,
}: {
  hostDecisionId: string | null;
  matchBasis: HeldDecisionMatchBasis;
}): HeldDecisionReview | null => {
  if (hostDecisionId !== null) {
    return null;
  }
  switch (matchBasis) {
    case HELD_DECISION_MATCH_BASIS.ECLI:
    case HELD_DECISION_MATCH_BASIS.COURT_DOCKET_DATE:
      return HELD_DECISION_REVIEW.SEVERAL_HELD;
    case HELD_DECISION_MATCH_BASIS.COURT_DOCKET_OTHER_DATE:
      return HELD_DECISION_REVIEW.DOCKET_HELD_OTHER_DATE;
    case HELD_DECISION_MATCH_BASIS.SOURCE_POLICY:
      return HELD_DECISION_REVIEW.SOURCE_POLICY;
    default:
      matchBasis satisfies never;
      return panic(
        `Unhandled held-decision match basis: ${String(matchBasis)}`,
      );
  }
};

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

/** Identity evidence is separate from a publisher's document-part declaration. */
export type HeldDecisionMatchEvidence =
  | {
      status: "matched";
      basis:
        | typeof HELD_DECISION_MATCH_BASIS.ECLI
        | typeof HELD_DECISION_MATCH_BASIS.COURT_DOCKET_DATE;
      /** Both values stay attributed through the attachment source and host source. */
      ecliDiscrepancy: { sourceValue: string; hostValue: string } | null;
    }
  | {
      status: "conflict";
      ecliCandidateIds: string[];
      courtDocketDateCandidateIds: string[];
    }
  | { status: "ambiguous"; completeness: "complete" | "overflow" }
  | { status: "outside-policy"; adapterKey: string };
