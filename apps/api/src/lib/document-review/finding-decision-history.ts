import { eq, sql } from "drizzle-orm";
import type { PgInsertValue } from "drizzle-orm/pg-core";

import type { ReviewDecision } from "@stll/api-contract/review-decision";

import type { Transaction } from "@/api/db/root";
import {
  documentReviewFindingDecisions,
  documentReviewFindings,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { sqlCaseFragment } from "@/api/lib/sql-case-expression";

import {
  DOCUMENT_REVIEW_DECISION,
  DOCUMENT_REVIEW_FINDING_DECISION,
} from "./run-contract";

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

/** The history event each stored decision word reads as, from the one map
 * that owns it; `open` has none. */
const BASELINE_DECISION_SQL = sqlCaseFragment({
  operand: sql`finding.decision`,
  branches: Object.entries(DOCUMENT_REVIEW_FINDING_DECISION).flatMap(
    ([stored, event]) =>
      event === null ? [] : [sql`WHEN ${stored} THEN ${event}`],
  ),
  fallback: sql`NULL`,
});

/**
 * Give each decided finding among these that has no decision event its
 * baseline, from the row as it stands: the decision, its decider and moment,
 * keyed by the finding's id exactly as the online backfill and
 * `findingDecisionRows` key it, so the three writers add it at most once
 * between them. Every write that decides a finding without going through the
 * decide handler calls this, so no decided finding is left without history:
 * the online backfill reads such a row as unfinished work.
 */
export const appendMissingBaselineDecisions = async (
  tx: Transaction,
  workspaceId: SafeId<"workspace">,
  findingIds: readonly SafeId<"documentReviewFinding">[],
): Promise<void> => {
  if (findingIds.length === 0) {
    return;
  }
  // audit: skip - the baseline restates a decision already audited when taken.
  // One bound list keeps the statement text fixed whatever its length.
  await tx.execute(sql`
    INSERT INTO ${documentReviewFindingDecisions}
      (id, workspace_id, finding_id, decision, reason, actor_id, created_at)
    SELECT finding.id, finding.workspace_id, finding.id, ${BASELINE_DECISION_SQL},
           NULL, finding.decided_by, COALESCE(finding.decided_at, clock_timestamp())
      FROM ${documentReviewFindings} AS finding
     WHERE finding.id = ANY(string_to_array(${findingIds.join(",")}, ',')::uuid[])
       AND finding.workspace_id = ${workspaceId}
       AND finding.decision <> ${DOCUMENT_REVIEW_DECISION.OPEN}
       AND NOT EXISTS (
         SELECT 1 FROM ${documentReviewFindingDecisions} AS event
          WHERE event.finding_id = finding.id
       )
    ON CONFLICT (id) DO NOTHING`);
};

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
