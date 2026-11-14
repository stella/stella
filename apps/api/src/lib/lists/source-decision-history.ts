import { eq, sql } from "drizzle-orm";
import type { PgInsertValue } from "drizzle-orm/pg-core";

import type { ReviewDecision } from "@stll/api-contract/review-decision";
import { REVIEW_STATUS_DECISION } from "@stll/api-contract/review-decision";

import type { Transaction } from "@/api/db/root";
import {
  legalListItemSourceDecisions,
  legalListItemSources,
  type LegalListSourceVerificationStatus,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";

type DecisionEvent = typeof legalListItemSourceDecisions.$inferInsert;
type DecisionRow = PgInsertValue<typeof legalListItemSourceDecisions>;
type StoredSource = typeof legalListItemSources.$inferSelect;
type PreviousSource = Pick<
  StoredSource,
  "verificationStatus" | "verifiedBy" | "verifiedAt" | "updatedAt"
>;

/** `RETURNING` fields reading the row an update locked, before its change. */
export const previousSourceDecision = {
  verificationStatus: sql<LegalListSourceVerificationStatus>`old.verification_status`,
  verifiedBy: sql<PreviousSource["verifiedBy"]>`old.verified_by`,
  verifiedAt: sql`old.verified_at`.mapWith(legalListItemSources.verifiedAt),
  updatedAt: sql`old.updated_at`.mapWith(legalListItemSources.updatedAt),
};

type SourceDecisionChange = {
  workspaceId: DecisionEvent["workspaceId"];
  sourceId: DecisionEvent["sourceId"];
  /** The source as the caller's update locked it, before the change. */
  previous: PreviousSource;
  decision: ReviewDecision | null;
  actorId: string;
  /** Whether the source already has any decision event. */
  hasHistory: boolean;
};

export const sourceHasDecisionHistory = async (
  tx: Transaction,
  sourceId: DecisionEvent["sourceId"],
): Promise<boolean> =>
  (
    await tx
      .select({ id: legalListItemSourceDecisions.id })
      .from(legalListItemSourceDecisions)
      .where(eq(legalListItemSourceDecisions.sourceId, sourceId))
      .limit(1)
  ).length > 0;

/**
 * The events one decision change appends to a source's history.
 *
 * A source decided before its history began has no event for that
 * decision, so it comes first, from the locked row. That baseline takes the
 * source's id, as the online backfill's does, so with the caller's
 * `onConflictDoNothing` the two add it at most once between them.
 */
export const sourceDecisionRows = (
  change: SourceDecisionChange,
): DecisionRow[] => {
  const baseline =
    REVIEW_STATUS_DECISION.listItemSource[change.previous.verificationStatus];
  const event: DecisionRow = {
    id: createSafeId<"legalListItemSourceDecision">(),
    workspaceId: change.workspaceId,
    sourceId: change.sourceId,
    decision: change.decision,
    actorId: change.actorId,
    // The column default reads the clock at insert, after the row lock.
  };
  if (baseline === null || change.hasHistory) {
    return [event];
  }
  return [
    {
      id: sql`${change.sourceId}::uuid`,
      workspaceId: change.workspaceId,
      sourceId: change.sourceId,
      decision: baseline,
      actorId: change.previous.verifiedBy,
      createdAt: change.previous.verifiedAt ?? change.previous.updatedAt,
    },
    event,
  ];
};
