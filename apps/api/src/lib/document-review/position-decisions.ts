/**
 * How an organization has actually decided a position.
 *
 * Derived, never stored: findings are already durable and already keyed by
 * `positionId`, so a position's track record is a grouped read over them rather
 * than a signals table that would have to be kept in step with every decision.
 *
 * One statement for a whole playbook. The scan is the
 * `(organization_id, position_id)` index; the JSONB in the projection is read
 * only from rows that index already selected, never used to find them.
 */

import { and, eq, inArray, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { documentReviewFindings } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { DOCUMENT_REVIEW_DECISION } from "@/api/lib/document-review/run-contract";

export type PositionDecisionSummary = {
  accepted: number;
  dismissed: number;
  /** Runs that graded this position at all, decided or not: the denominator
   *  that turns two dismissals into "dismissed twice out of two". */
  runs: number;
  /**
   * The text the most recently accepted fix for this position carried — a
   * replacement term for a parameter fix, a whole block otherwise. Null when no
   * accepted finding proposed an edit.
   */
  latestAcceptedFixText: string | null;
};

export type PositionDecisionOverlay = Record<string, PositionDecisionSummary>;

type ReadPositionDecisionOverlayArgs = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  /** The position `sourceId`s to report on; bounded by the positions cap. */
  positionIds: readonly string[];
};

/**
 * Decision counts per position, for the positions asked about. A position no
 * run has graded is simply absent from the result: the reader treats a missing
 * entry as "no history", which is what it is.
 */
export const readPositionDecisionOverlay = async ({
  tx,
  organizationId,
  positionIds,
}: ReadPositionDecisionOverlayArgs): Promise<PositionDecisionOverlay> => {
  if (positionIds.length === 0) {
    return {};
  }

  // A fix is one of three shapes; two of them name their text `text` and the
  // parameter one names it `replace`. Exactly one is ever present.
  const fixText = sql`coalesce(
    ${documentReviewFindings.payload}->'finding'->'fix'->>'replace',
    ${documentReviewFindings.payload}->'finding'->'fix'->>'text'
  )`;
  const accepted = sql`${documentReviewFindings.decision} = ${DOCUMENT_REVIEW_DECISION.ACCEPTED}`;

  const rows = await tx
    .select({
      positionId: documentReviewFindings.positionId,
      accepted: sql<number>`(count(*) filter (where ${accepted}))::int`,
      dismissed: sql<number>`(count(*) filter (where ${documentReviewFindings.decision} = ${DOCUMENT_REVIEW_DECISION.DISMISSED}))::int`,
      runs: sql<number>`(count(distinct ${documentReviewFindings.runId}))::int`,
      // Newest accepted decision first; `updated_at` breaks a tie inside the
      // same moment so the pick is stable rather than whatever order the scan
      // happened to produce.
      latestAcceptedFixText: sql<
        string | null
      >`(array_agg(${fixText} ORDER BY ${documentReviewFindings.decidedAt} DESC NULLS LAST, ${documentReviewFindings.updatedAt} DESC)
        filter (where ${accepted} AND ${fixText} IS NOT NULL))[1]`,
    })
    .from(documentReviewFindings)
    .where(
      and(
        eq(documentReviewFindings.organizationId, organizationId),
        inArray(documentReviewFindings.positionId, [...positionIds]),
      ),
    )
    .groupBy(documentReviewFindings.positionId);

  return Object.fromEntries(
    rows.map((row) => [
      row.positionId,
      {
        accepted: row.accepted,
        dismissed: row.dismissed,
        runs: row.runs,
        latestAcceptedFixText: row.latestAcceptedFixText,
      },
    ]),
  );
};
