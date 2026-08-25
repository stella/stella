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
 *
 * Completion is also where a run's proposed fixes become Folio suggestions —
 * for the worker only, because the files-table path grades many documents at
 * once against a tier ladder and never grounds a fix.
 */

import { and, count, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { documentReviewFindings, documentReviewRuns } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { carryOverDecisions } from "@/api/lib/document-review/decision-carry-over";
import { stageReviewFixSuggestions } from "@/api/lib/document-review/review-suggestion-staging";
import { DOCUMENT_REVIEW_RUN_EXECUTOR } from "@/api/lib/document-review/run-contract";
import type { DocumentReviewRunExecutor } from "@/api/lib/document-review/run-contract";

export type FinalizeReviewRunArgs = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  runId: SafeId<"documentReviewRun">;
  entityId: SafeId<"entity">;
  fileFieldId: SafeId<"field">;
  /** Which producer is finishing this run, named rather than inferred: only
   *  the worker path stages suggestions. */
  executor: DocumentReviewRunExecutor;
  /** The exact number of finding rows a completed run holds, from the plan. */
  expectedFindingCount: number;
};

export type FinalizeReviewRunResult =
  | {
      type: "completed";
      committed: number;
      carried: number;
      /** Suggestion rows this call inserted; zero on a replayed completion. */
      staged: number;
    }
  | { type: "incomplete"; committed: number };

export const finalizeReviewRun = async ({
  tx,
  workspaceId,
  runId,
  entityId,
  fileFieldId,
  executor,
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
  });

  // After carry-over, so a finding whose decision the reviewer already took in
  // the previous review of this document is not staged again as a proposal.
  const staged =
    executor === DOCUMENT_REVIEW_RUN_EXECUTOR.WORKER
      ? await stageReviewFixSuggestions({ tx, workspaceId, entityId, runId })
      : 0;

  // audit: skip — terminal bookkeeping on the run row audited at create.
  await tx
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
    );

  return { type: "completed", committed, carried, staged };
};
