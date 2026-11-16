/**
 * Writing findings onto a run.
 *
 * Both producers land here: the review worker, which executes one document at a
 * time from a queued run, and the files-table path, which grades many documents
 * through the property DAG. Every batch either one writes goes through
 * `writeReviewFindingBatch`: one row builder, one upsert and one progress
 * recount, so the conflict key, the columns a re-delivered write refreshes and
 * the progress a reviewer sees cannot drift between them. Where the two differ,
 * the difference is the `executor` variant of that call.
 */

import { panic } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { documentReviewFindings, documentReviewRuns } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import type { LockedTableRun } from "@/api/lib/db/aggregate-lock";
import { DOCUMENT_REVIEW_RUN_EXECUTOR } from "@/api/lib/document-review/run-contract";
import type { DocumentReviewFindingPayload } from "@/api/lib/document-review/run-contract";
import { finalizeReviewRun } from "@/api/lib/document-review/run-finalize";
import type { FinalizeReviewRunResult } from "@/api/lib/document-review/run-finalize";

export type DocumentReviewFindingRow =
  typeof documentReviewFindings.$inferInsert;

export type BuildDocumentReviewFindingRowArgs = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  runId: SafeId<"documentReviewRun">;
  entityId: SafeId<"entity">;
  fileFieldId: SafeId<"field">;
  entityVersionId: SafeId<"entityVersion">;
  positionId: string;
  positionTitle: string;
  payload: DocumentReviewFindingPayload;
};

export const buildDocumentReviewFindingRow = ({
  organizationId,
  workspaceId,
  runId,
  entityId,
  fileFieldId,
  entityVersionId,
  positionId,
  positionTitle,
  payload,
}: BuildDocumentReviewFindingRowArgs): DocumentReviewFindingRow => ({
  id: createSafeId<"documentReviewFinding">(),
  organizationId,
  workspaceId,
  runId,
  entityId,
  fileFieldId,
  entityVersionId,
  positionId,
  positionTitle,
  outcome: payload.finding.verdict,
  payload,
});

/**
 * Commit findings on the `(runId, positionId)` key. A replayed write overwrites
 * the row it wrote before rather than adding a second judgment for the same
 * position, so duplicate delivery converges instead of doubling the review.
 *
 * The reviewer's disposition is deliberately absent from the update set: a
 * re-delivery must refresh what the engine said, never reset what a lawyer
 * decided about it.
 */
const upsertDocumentReviewFindings = async (
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
      target: [documentReviewFindings.runId, documentReviewFindings.positionId],
      set: {
        entityVersionId: sql`excluded.entity_version_id`,
        positionTitle: sql`excluded.position_title`,
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
 * Set the run's `completed` to the findings it holds, which is what the review
 * surface polls. Every batch runs it in the transaction that wrote its rows, so
 * the number never runs ahead of them. Batches that overlap without the run's
 * row lock may each count before a sibling commits and leave the last update
 * stale, so the worker runs it once more after its pass settles.
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

type WriteReviewFindingBatchArgs = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  rows: readonly DocumentReviewFindingRow[];
} & (
  | {
      /** One pass writes every batch, and the run completes once after it
       *  through `finalizeWorkerRun`, so a batch commits and reports progress
       *  only. A shortfall then fails the run instead of waiting for more. */
      executor: typeof DOCUMENT_REVIEW_RUN_EXECUTOR.WORKER;
      runId: SafeId<"documentReviewRun">;
    }
  | {
      /** Batches arrive from independent workflow jobs and any one may be the
       *  last, so each tries to complete the run. Takes the run under the row
       *  lock `lockActiveTableRun` holds: without it the last two batches would
       *  each count without the other's uncommitted findings. */
      executor: typeof DOCUMENT_REVIEW_RUN_EXECUTOR.TABLE;
      run: LockedTableRun;
      entityId: SafeId<"entity">;
      expectedFindingCount: number;
    }
);

export type WriteReviewFindingBatchResult =
  { type: "deferred" } | FinalizeReviewRunResult;

const batchRunId = (
  args: WriteReviewFindingBatchArgs,
): SafeId<"documentReviewRun"> => {
  switch (args.executor) {
    case DOCUMENT_REVIEW_RUN_EXECUTOR.WORKER:
      return args.runId;
    case DOCUMENT_REVIEW_RUN_EXECUTOR.TABLE:
      return args.run.id;
    default:
      args satisfies never;
      return panic("Unhandled review run executor");
  }
};

/**
 * Commit one batch of a run's findings: the upsert, the progress recount, and
 * for the files-table path the completion attempt, all in the caller's
 * transaction. The one way either executor writes findings.
 */
export const writeReviewFindingBatch = async (
  args: WriteReviewFindingBatchArgs,
): Promise<WriteReviewFindingBatchResult> => {
  const { tx, workspaceId, rows } = args;
  const runId = batchRunId(args);
  if (rows.some((row) => row.runId !== runId)) {
    return panic("A finding batch holds rows of another run");
  }
  await upsertDocumentReviewFindings(tx, rows);
  await recountDocumentReviewFindingProgress({ tx, workspaceId, runId });

  switch (args.executor) {
    case DOCUMENT_REVIEW_RUN_EXECUTOR.WORKER:
      return { type: "deferred" };
    case DOCUMENT_REVIEW_RUN_EXECUTOR.TABLE:
      return await finalizeReviewRun({
        tx,
        workspaceId,
        runId,
        entityId: args.entityId,
        fileFieldId: args.run.fileFieldId,
        executor: DOCUMENT_REVIEW_RUN_EXECUTOR.TABLE,
        expectedFindingCount: args.expectedFindingCount,
      });
    default:
      args satisfies never;
      return panic("Unhandled review run executor");
  }
};
