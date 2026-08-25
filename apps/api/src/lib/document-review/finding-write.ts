/**
 * Writing findings onto a run.
 *
 * Both producers land here: the review worker, which executes one document at a
 * time from a queued run, and the files-table path, which grades many documents
 * through the property DAG. One row builder and one upsert, so the conflict key
 * and the columns a re-delivered write refreshes cannot drift between them.
 */

import { and, eq, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { documentReviewFindings, documentReviewRuns } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { findingOutcome } from "@/api/lib/document-review/run-contract";
import type { DocumentReviewFindingPayload } from "@/api/lib/document-review/run-contract";

export type DocumentReviewFindingRow =
  typeof documentReviewFindings.$inferInsert;

export type BuildDocumentReviewFindingRowArgs = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  runId: SafeId<"documentReviewRun">;
  entityId: SafeId<"entity">;
  fileFieldId: SafeId<"field">;
  entityVersionId: SafeId<"entityVersion">;
  topicId: string;
  topicTitle: string;
  /** Set only on a playbook-kind row, which grades one playbook position. */
  positionId: string | null;
  payload: DocumentReviewFindingPayload;
};

export const buildDocumentReviewFindingRow = ({
  organizationId,
  workspaceId,
  runId,
  entityId,
  fileFieldId,
  entityVersionId,
  topicId,
  topicTitle,
  positionId,
  payload,
}: BuildDocumentReviewFindingRowArgs): DocumentReviewFindingRow => ({
  id: createSafeId<"documentReviewFinding">(),
  organizationId,
  workspaceId,
  runId,
  entityId,
  fileFieldId,
  entityVersionId,
  topicId,
  topicTitle,
  checkKind: payload.checkKind,
  positionId,
  outcome: findingOutcome(payload),
  payload,
});

/**
 * Commit findings on the `(runId, topicId, checkKind)` key. A replayed write
 * overwrites the row it wrote before rather than adding a second judgment for
 * the same topic, so duplicate delivery converges instead of doubling the
 * review.
 *
 * The reviewer's disposition is deliberately absent from the update set: a
 * re-delivery must refresh what the engine said, never reset what a lawyer
 * decided about it.
 */
export const upsertDocumentReviewFindings = async (
  tx: Transaction,
  rows: readonly DocumentReviewFindingRow[],
): Promise<void> => {
  if (rows.length === 0) {
    return;
  }
  // audit: skip — review output attached to the run row audited at create.
  await tx
    .insert(documentReviewFindings)
    .values([...rows])
    .onConflictDoUpdate({
      target: [
        documentReviewFindings.runId,
        documentReviewFindings.topicId,
        documentReviewFindings.checkKind,
      ],
      set: {
        entityVersionId: sql`excluded.entity_version_id`,
        topicTitle: sql`excluded.topic_title`,
        positionId: sql`excluded.position_id`,
        outcome: sql`excluded.outcome`,
        payload: sql`excluded.payload`,
        updatedAt: new Date(),
      },
    });
};

type RecountDocumentReviewFindingProgressArgs = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  runId: SafeId<"documentReviewRun">;
};

/**
 * Recount after all concurrent review passes settle. Each pass reports useful
 * intermediate progress, but their transactions may take snapshots before a
 * sibling commits and leave the last update stale. This final pass runs after
 * both producers have committed, so the run row reflects the durable set.
 */
export const recountDocumentReviewFindingProgress = async ({
  tx,
  workspaceId,
  runId,
}: RecountDocumentReviewFindingProgressArgs): Promise<void> => {
  // audit: skip — progress bookkeeping on the run row audited at create.
  await tx
    .update(documentReviewRuns)
    .set({
      completed: sql<number>`(
        select count(*)::int from ${documentReviewFindings}
        where ${documentReviewFindings.runId} = ${documentReviewRuns.id}
          and ${documentReviewFindings.workspaceId} = ${workspaceId}
      )`,
    })
    .where(
      and(
        eq(documentReviewRuns.id, runId),
        eq(documentReviewRuns.workspaceId, workspaceId),
        eq(documentReviewRuns.status, "running"),
      ),
    );
};
