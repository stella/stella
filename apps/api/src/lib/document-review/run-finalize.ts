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
 * twice. A caller whose batches can overlap must hold the run's row lock, or
 * each would count without the other's uncommitted findings.
 *
 * Completion is also where a run's proposed fixes become Folio suggestions —
 * for the worker only, because the files-table path grades many documents at
 * once against a tier ladder and never grounds a fix.
 */

import { panic } from "better-result";
import { and, count, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { documentReviewFindings, documentReviewRuns } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { carryOverDecisions } from "@/api/lib/document-review/decision-carry-over";
import { basisReferenceWorkspaceIds } from "@/api/lib/document-review/reference-passages";
import {
  REVIEW_FIX_STAGING,
  stageReviewFixSuggestions,
} from "@/api/lib/document-review/review-suggestion-staging";
import type {
  ReviewFixStaging,
  StagedReviewFixSuggestions,
} from "@/api/lib/document-review/review-suggestion-staging";
import { DOCUMENT_REVIEW_RUN_EXECUTOR } from "@/api/lib/document-review/run-contract";
import type { DocumentReviewRunBasis } from "@/api/lib/document-review/run-contract";
import type { RootRunActor } from "@/api/lib/root-scoped-db";
import { maybeEmitDocumentReviewSignal } from "@/api/lib/scouts/document-review";

export type FinalizeReviewRunArgs = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  runId: SafeId<"documentReviewRun">;
  entityId: SafeId<"entity">;
  fileFieldId: SafeId<"field">;
  /** The exact number of finding rows a completed run holds, from the plan. */
  expectedFindingCount: number;
} & (
  | {
      executor: typeof DOCUMENT_REVIEW_RUN_EXECUTOR.WORKER;
      fixStaging: ReviewFixStaging;
    }
  | { executor: typeof DOCUMENT_REVIEW_RUN_EXECUTOR.TABLE }
);

export type FinalizeReviewRunResult =
  | {
      type: "completed";
      committed: number;
      carried: number;
      /** Suggestion rows this call inserted; zero on a replayed completion. */
      staged: number;
      /** New fixes left unstaged because the document is at its pending cap. */
      skippedForPendingLimit: number;
      /** Fixes left unstaged because the requester cannot open a source matter. */
      skippedForUnreadableReference: number;
    }
  | { type: "incomplete"; committed: number };

const stageForProducer = async (
  args: FinalizeReviewRunArgs,
): Promise<StagedReviewFixSuggestions> => {
  switch (args.executor) {
    case DOCUMENT_REVIEW_RUN_EXECUTOR.WORKER:
      return await stageReviewFixSuggestions({
        tx: args.tx,
        workspaceId: args.workspaceId,
        entityId: args.entityId,
        runId: args.runId,
        fixStaging: args.fixStaging,
      });
    case DOCUMENT_REVIEW_RUN_EXECUTOR.TABLE:
      return {
        staged: 0,
        skippedForPendingLimit: 0,
        skippedForUnreadableReference: 0,
      };
    default:
      args satisfies never;
      return panic("Unhandled review run executor");
  }
};

export const finalizeReviewRun = async (
  args: FinalizeReviewRunArgs,
): Promise<FinalizeReviewRunResult> => {
  const {
    tx,
    workspaceId,
    runId,
    entityId,
    fileFieldId,
    expectedFindingCount,
  } = args;
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
  const staging = await stageForProducer(args);

  // audit: skip — terminal bookkeeping on the run row audited at create.
  const flipped = await tx
    .update(documentReviewRuns)
    .set({
      status: "completed",
      errorCode: null,
      completed: committed,
      fixesWithheld: staging.skippedForUnreadableReference,
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

  return {
    type: "completed",
    committed,
    carried,
    staged: staging.staged,
    skippedForPendingLimit: staging.skippedForPendingLimit,
    skippedForUnreadableReference: staging.skippedForUnreadableReference,
  };
};

type FinalizeWorkerRunArgs = {
  actor: RootRunActor<"documentReviewRun">;
  basis: DocumentReviewRunBasis;
  entityId: SafeId<"entity">;
  fileFieldId: SafeId<"field">;
  expectedFindingCount: number;
};

/**
 * The worker's completion. `writeDb` reaches only the reviewed matter, but a
 * staged fix records the other matters its text came from, and row security
 * lets a writer record only matters it holds. So the transaction also pins them
 * when the requester can open them all, and otherwise withholds the fixes and
 * completes the run anyway.
 */
export const finalizeWorkerRun = async ({
  actor,
  basis,
  entityId,
  fileFieldId,
  expectedFindingCount,
}: FinalizeWorkerRunArgs): Promise<FinalizeReviewRunResult> => {
  const sourceDataWorkspaceIds = basisReferenceWorkspaceIds(basis).filter(
    (referenceWorkspaceId) => referenceWorkspaceId !== actor.workspaceId,
  );
  const sourcesDb = await actor.writeDbWithReadableSources(
    sourceDataWorkspaceIds,
  );
  const fixStaging: ReviewFixStaging =
    sourcesDb === null
      ? { type: REVIEW_FIX_STAGING.withheld }
      : { type: REVIEW_FIX_STAGING.stage, sourceDataWorkspaceIds };
  const writeDb = sourcesDb ?? actor.writeDb;
  return await writeDb(
    async (tx) =>
      await finalizeReviewRun({
        tx,
        workspaceId: actor.workspaceId,
        runId: actor.runId,
        entityId,
        fileFieldId,
        executor: DOCUMENT_REVIEW_RUN_EXECUTOR.WORKER,
        fixStaging,
        expectedFindingCount,
      }),
  );
};
