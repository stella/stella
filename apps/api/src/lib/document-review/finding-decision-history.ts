import { eq, sql } from "drizzle-orm";
import type { PgInsertValue } from "drizzle-orm/pg-core";

import type { ReviewDecision } from "@stll/api-contract/review-decision";

import type { Transaction } from "@/api/db/root";
import {
  documentReviewFindingDecisions,
  type documentReviewFindings,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";

import { DOCUMENT_REVIEW_FINDING_DECISION } from "./run-contract";

type DecisionEvent = typeof documentReviewFindingDecisions.$inferInsert;
type DecisionRow = PgInsertValue<typeof documentReviewFindingDecisions>;
type StoredFinding = typeof documentReviewFindings.$inferSelect;

type FindingDecisionChange = {
  workspaceId: DecisionEvent["workspaceId"];
  findingId: DecisionEvent["findingId"];
  /** The finding as the caller's transaction locked it, before the change. */
  previous: Pick<StoredFinding, "decision" | "decidedBy" | "decidedAt">;
  decision: ReviewDecision | null;
  actorId: string;
  at: DecisionEvent["createdAt"];
  /** Whether the finding already has any decision event. */
  hasHistory: boolean;
};

export const findingHasDecisionHistory = async (
  tx: Transaction,
  findingId: DecisionEvent["findingId"],
): Promise<boolean> =>
  (
    await tx
      .select({ id: documentReviewFindingDecisions.id })
      .from(documentReviewFindingDecisions)
      .where(eq(documentReviewFindingDecisions.findingId, findingId))
      .limit(1)
  ).length > 0;

/**
 * The events one decision change appends to a finding's history.
 *
 * A finding decided before its history began has no event for that
 * decision, so it comes first, from the locked row. That baseline takes the
 * finding's id, as the online backfill's does, so with the caller's
 * `onConflictDoNothing` the two add it at most once between them.
 */
export const findingDecisionRows = (
  change: FindingDecisionChange,
): DecisionRow[] => {
  const baseline = DOCUMENT_REVIEW_FINDING_DECISION[change.previous.decision];
  const event: DecisionRow = {
    id: createSafeId<"documentReviewFindingDecision">(),
    workspaceId: change.workspaceId,
    findingId: change.findingId,
    decision: change.decision,
    reason: null,
    actorId: change.actorId,
    createdAt: change.at,
  };
  if (baseline === null || change.hasHistory) {
    return [event];
  }
  return [
    {
      id: sql`${change.findingId}::uuid`,
      workspaceId: change.workspaceId,
      findingId: change.findingId,
      decision: baseline,
      reason: null,
      actorId: change.previous.decidedBy,
      createdAt: change.previous.decidedAt ?? change.at,
    },
    event,
  ];
};
