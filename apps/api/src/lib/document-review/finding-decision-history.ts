/**
 * A finding's decision history: every decision its reviewers took and
 * withdrew, with who, when and why, and where it stands now, folded by the
 * shared review fold (`foldReviewDecisions`) a verified claim's decisions
 * fold through too. The database writes the events (the history trigger on
 * `document_review_findings`), so every surface that changes a decision is
 * in it.
 */

import { and, desc, eq } from "drizzle-orm";

import { foldReviewDecisions } from "@stll/api-contract/review-decision";
import type { ReviewDecisionEvent } from "@stll/api-contract/review-decision";

import type { Transaction } from "@/api/db/root";
import { documentReviewFindingDecisions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

/** The most recent decisions one read returns. The fold needs only the
 *  latest (each decision replaces the one before), so an older tail is
 *  left out and said to be. */
const FINDING_DECISION_HISTORY_MAX = 200;

type ReadFindingDecisionHistoryArgs = {
  tx: Pick<Transaction, "select">;
  workspaceId: SafeId<"workspace">;
  findingId: SafeId<"documentReviewFinding">;
};

export const readFindingDecisionHistory = async ({
  tx,
  workspaceId,
  findingId,
}: ReadFindingDecisionHistoryArgs) => {
  const newestFirst = await tx
    .select({
      decision: documentReviewFindingDecisions.decision,
      reason: documentReviewFindingDecisions.reason,
      actorId: documentReviewFindingDecisions.actorId,
      createdAt: documentReviewFindingDecisions.createdAt,
    })
    .from(documentReviewFindingDecisions)
    .where(
      and(
        eq(documentReviewFindingDecisions.workspaceId, workspaceId),
        eq(documentReviewFindingDecisions.findingId, findingId),
      ),
    )
    .orderBy(
      desc(documentReviewFindingDecisions.createdAt),
      desc(documentReviewFindingDecisions.id),
    )
    .limit(FINDING_DECISION_HISTORY_MAX + 1);
  const events: ReviewDecisionEvent[] = newestFirst
    .slice(0, FINDING_DECISION_HISTORY_MAX)
    .toReversed()
    .map((row) => ({
      decision: row.decision,
      reason: row.reason,
      actorId: row.actorId,
      at: row.createdAt.toISOString(),
    }));
  return {
    events,
    /** Older decisions exist than the events returned. */
    truncated: newestFirst.length > FINDING_DECISION_HISTORY_MAX,
    current: foldReviewDecisions(events),
  };
};
