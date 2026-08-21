/**
 * Completing a run.
 *
 * A run is complete when the finding set it promised is the finding set the
 * database holds — counted, not inferred from what the executor returned, so
 * the terminal state is a fact about the data rather than about a process.
 *
 * Completion is also where reviewer decisions cross over from the document's
 * previous review, in the same transaction as the status flip: a run is never
 * readable as completed with its inherited decisions still missing.
 *
 * Both producers finish here. The review worker calls it once, after both
 * passes have committed; the files-table path calls it after every batch of
 * verdicts, and it simply reports `incomplete` until the last one lands. That
 * is the whole reason this is one function: the carry-over rule must not exist
 * twice.
 */

import { and, count, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { documentReviewFindings, documentReviewRuns } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { carryOverDecisions } from "@/api/lib/document-review/decision-carry-over";
import type { DocumentReviewRunBasis } from "@/api/lib/document-review/run-contract";
import { maybeEmitDocumentReviewSignal } from "@/api/lib/scouts/document-review";

export type FinalizeReviewRunArgs = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  runId: SafeId<"documentReviewRun">;
  entityId: SafeId<"entity">;
  fileFieldId: SafeId<"field">;
  basisType: DocumentReviewRunBasis["type"];
  /** The exact number of finding rows a completed run holds, from the plan. */
  expectedFindingCount: number;
};

export type FinalizeReviewRunResult =
  | { type: "completed"; committed: number; carried: number }
  | { type: "incomplete"; committed: number };

export const finalizeReviewRun = async ({
  tx,
  workspaceId,
  runId,
  entityId,
  fileFieldId,
  basisType,
  expectedFindingCount,
}: FinalizeReviewRunArgs): Promise<FinalizeReviewRunResult> => {
  const counted = await tx
    .select({ value: count() })
    .from(documentReviewFindings)
    .where(
      and(
        eq(documentReviewFindings.runId, runId),
        eq(documentReviewFindings.workspaceId, workspaceId),
      ),
    );
  const first = counted.at(0);
  const committed = first === undefined ? 0 : first.value;

  if (committed !== expectedFindingCount) {
    return { type: "incomplete", committed };
  }

  const carried = await carryOverDecisions({
    tx,
    workspaceId,
    runId,
    entityId,
    fileFieldId,
    basisType,
  });

  // audit: skip — terminal bookkeeping on the run row audited at create.
  const flipped = await tx
    .update(documentReviewRuns)
    .set({
      status: "completed",
      errorCode: null,
      completed: committed,
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(documentReviewRuns.id, runId),
        eq(documentReviewRuns.workspaceId, workspaceId),
        eq(documentReviewRuns.status, "running"),
      ),
    )
    .returning({ id: documentReviewRuns.id });

  // The single completion point for both producers, so the inbox learns of
  // every finished review exactly once.
  if (flipped.length > 0) {
    await maybeEmitDocumentReviewSignal({ tx, workspaceId, runId });
  }

  return { type: "completed", committed, carried };
};
