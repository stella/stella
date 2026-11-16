/**
 * A finding's decision history: every decision its reviewers took and
 * withdrew, with who, when and why, and where it stands now, folded by the
 * shared review fold (`foldReviewDecisions`) a verified claim's decisions
 * fold through too. The database writes the events (the history trigger on
 * `document_review_findings`), so every surface that changes a decision is
 * in it.
 */

import { and, asc, desc, eq } from "drizzle-orm";

import { foldReviewDecisions } from "@stll/api-contract/review-decision";
import type { ReviewDecisionEvent } from "@stll/api-contract/review-decision";

import type { Transaction } from "@/api/db/root";
import { documentReviewFindingDecisions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { readBounded } from "@/api/lib/db/read-bounded";

/** The longest history one read returns whole. */
const FINDING_DECISION_HISTORY_MAX = 500;

type ReadFindingDecisionHistoryArgs = {
  tx: Pick<Transaction, "select">;
  workspaceId: SafeId<"workspace">;
  findingId: SafeId<"documentReviewFinding">;
};

const toEvent = (row: {
  decision: ReviewDecisionEvent["decision"];
  reason: string | null;
  actorId: string | null;
  createdAt: Date;
}): ReviewDecisionEvent => ({
  decision: row.decision,
  reason: row.reason,
  actorId: row.actorId,
  at: row.createdAt.toISOString(),
});

export const readFindingDecisionHistory = async ({
  tx,
  workspaceId,
  findingId,
}: ReadFindingDecisionHistoryArgs) => {
  const columns = {
    decision: documentReviewFindingDecisions.decision,
    reason: documentReviewFindingDecisions.reason,
    actorId: documentReviewFindingDecisions.actorId,
    createdAt: documentReviewFindingDecisions.createdAt,
  };
  const ofFinding = and(
    eq(documentReviewFindingDecisions.workspaceId, workspaceId),
    eq(documentReviewFindingDecisions.findingId, findingId),
  );
  const read = await readBounded(
    tx
      .select(columns)
      .from(documentReviewFindingDecisions)
      .where(ofFinding)
      .orderBy(
        asc(documentReviewFindingDecisions.createdAt),
        asc(documentReviewFindingDecisions.id),
      ),
    FINDING_DECISION_HISTORY_MAX,
  );
  if (read.type === "complete") {
    const events = read.rows.map(toEvent);
    return { events, truncated: false, current: foldReviewDecisions(events) };
  }
  // Longer than one read: each decision replaces the one before, so the
  // latest alone says where the finding stands; the older ones are left out
  // and said to be.
  const latest = await tx
    .select(columns)
    .from(documentReviewFindingDecisions)
    .where(ofFinding)
    .orderBy(
      desc(documentReviewFindingDecisions.createdAt),
      desc(documentReviewFindingDecisions.id),
    )
    .limit(1);
  const events = latest.map(toEvent);
  return { events, truncated: true, current: foldReviewDecisions(events) };
};
