/**
 * How many of a run's findings sit in each reviewer decision.
 *
 * Counted, never stored: the number is a fact about the finding rows, and a
 * stored copy would have to be corrected by every decision, every carry-over,
 * and every re-run.
 *
 * Two shapes for one concept, each bound to what its reader already has in
 * hand. The run read returns every finding, so it tallies the rows it is
 * already sending and cannot disagree with its own body. The run list returns
 * no findings at all, so it counts them in the same statement that pages the
 * runs rather than adding a round-trip per page.
 */

import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { documentReviewFindings } from "@/api/db/schema";
import { DOCUMENT_REVIEW_DECISION } from "@/api/lib/document-review/run-contract";
import type { DocumentReviewDecision } from "@/api/lib/document-review/run-contract";

export type DocumentReviewDecisionCounts = Record<
  DocumentReviewDecision,
  number
>;

/** Tally decisions already loaded into memory. Total over the vocabulary: a
 *  new decision value cannot be added without a zero entry here. */
export const tallyDecisions = (
  decisions: readonly DocumentReviewDecision[],
): DocumentReviewDecisionCounts => {
  const counts: DocumentReviewDecisionCounts = {
    open: 0,
    accepted: 0,
    dismissed: 0,
  };
  for (const decision of decisions) {
    counts[decision] += 1;
  }
  return counts;
};

const decisionFilterCount = (decision: DocumentReviewDecision): SQL<number> =>
  sql<number>`count(${documentReviewFindings.id}) filter (where ${documentReviewFindings.decision} = ${decision})::int`;

/**
 * The aggregate expressions a run-list query selects alongside its page.
 * Written out per decision and checked total against the vocabulary, so a new
 * decision value fails typecheck here instead of silently going uncounted.
 */
export const DECISION_COUNT_COLUMNS = {
  open: decisionFilterCount(DOCUMENT_REVIEW_DECISION.OPEN),
  accepted: decisionFilterCount(DOCUMENT_REVIEW_DECISION.ACCEPTED),
  dismissed: decisionFilterCount(DOCUMENT_REVIEW_DECISION.DISMISSED),
} as const satisfies Record<DocumentReviewDecision, SQL<number>>;

/** The counted columns, reassembled into the response shape. */
export const toDecisionCounts = (row: {
  decisionsOpen: number;
  decisionsAccepted: number;
  decisionsDismissed: number;
}): DocumentReviewDecisionCounts => ({
  open: row.decisionsOpen,
  accepted: row.decisionsAccepted,
  dismissed: row.decisionsDismissed,
});
