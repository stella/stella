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
 *
 * The rest of a run's lifecycle that both producers share lives here too: the
 * failure write and the record of sources a run read only in part. Each
 * batch's findings go through `writeReviewFindingBatch` in finding-write.ts,
 * which ends here for the files-table path.
 */

import { panic } from "better-result";
import { and, count, eq, inArray, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { documentReviewFindings, documentReviewRuns } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { holdLiveSourceWorkspaces } from "@/api/lib/db/aggregate-lock";
import type { ReviewWithheldSource } from "@/api/lib/document-review/contract";
import { carryOverDecisions } from "@/api/lib/document-review/decision-carry-over";
import { basisFixSourceWorkspaceIds } from "@/api/lib/document-review/reference-passages";
import {
  REVIEW_FIX_STAGING,
  stageReviewFixSuggestions,
} from "@/api/lib/document-review/review-suggestion-staging";
import type {
  ReviewFixStaging,
  StagedReviewFixSuggestions,
} from "@/api/lib/document-review/review-suggestion-staging";
import {
  DOCUMENT_REVIEW_RUN_ACTIVE_STATUSES,
  DOCUMENT_REVIEW_RUN_EXECUTOR,
} from "@/api/lib/document-review/run-contract";
import type {
  DocumentReviewRunBasis,
  DocumentReviewRunErrorCode,
  DocumentReviewRunStatus,
} from "@/api/lib/document-review/run-contract";
import { logger } from "@/api/lib/observability/logger";
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

type ReplayFixesWithheldArgs = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  runId: SafeId<"documentReviewRun">;
  withheldThisPass: number;
};

/**
 * A replay of a completed run either stages the fixes (withholding none) or
 * withholds every open one. Row security hides a suggestion whose source
 * matter the requester can no longer open, so a withholding pass cannot see
 * which fixes an earlier pass staged; the run's stored count can only fall.
 */
const replayFixesWithheld = async ({
  tx,
  workspaceId,
  runId,
  withheldThisPass,
}: ReplayFixesWithheldArgs) => {
  // audit: skip — terminal bookkeeping on the run row audited at create.
  const updated = await tx
    .update(documentReviewRuns)
    .set({
      fixesWithheld: sql`least(${documentReviewRuns.fixesWithheld}, ${withheldThisPass})`,
    })
    .where(
      and(
        eq(documentReviewRuns.id, runId),
        eq(documentReviewRuns.workspaceId, workspaceId),
        eq(documentReviewRuns.status, "completed"),
      ),
    )
    .returning({ fixesWithheld: documentReviewRuns.fixesWithheld });
  return updated.at(0)?.fixesWithheld ?? withheldThisPass;
};

type ReviewRunRef = {
  workspaceId: SafeId<"workspace">;
  runId: SafeId<"documentReviewRun">;
};

/**
 * The one statement that moves a review run's status, for both executors:
 * completion, failure, and the bookkeeping written while a run is open. It
 * matches only a run still in one of `statuses`, so a write that lost a race
 * to a terminal state changes nothing. Returns whether the run matched.
 */
const updateRunWhileIn = async (
  tx: Transaction,
  { workspaceId, runId }: ReviewRunRef,
  statuses: readonly DocumentReviewRunStatus[],
  values: Partial<typeof documentReviewRuns.$inferInsert>,
): Promise<boolean> => {
  // audit: skip — lifecycle bookkeeping on the run row audited at create.
  const updated = await tx
    .update(documentReviewRuns)
    .set(values)
    .where(
      and(
        eq(documentReviewRuns.id, runId),
        eq(documentReviewRuns.workspaceId, workspaceId),
        inArray(documentReviewRuns.status, [...statuses]),
      ),
    )
    .returning({ id: documentReviewRuns.id });
  return updated.length > 0;
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

  const { carried } = await carryOverDecisions({
    tx,
    workspaceId,
    runId,
    entityId,
    fileFieldId,
  });

  // After carry-over, so a finding whose decision the reviewer already took in
  // the previous review of this document is not staged again as a proposal.
  const staging = await stageForProducer(args);

  const flipped = await updateRunWhileIn(
    tx,
    { workspaceId, runId },
    ["running"],
    {
      status: "completed",
      errorCode: null,
      completed: committed,
      fixesWithheld: staging.skippedForUnreadableReference,
      finishedAt: new Date(),
    },
  );

  // The single completion point for both producers, so the inbox learns of
  // every finished review exactly once.
  if (flipped) {
    await maybeEmitDocumentReviewSignal({ tx, workspaceId, runId });
  }
  const skippedForUnreadableReference = flipped
    ? staging.skippedForUnreadableReference
    : await replayFixesWithheld({
        tx,
        workspaceId,
        runId,
        withheldThisPass: staging.skippedForUnreadableReference,
      });

  return {
    type: "completed",
    committed,
    carried,
    staged: staging.staged,
    skippedForPendingLimit: staging.skippedForPendingLimit,
    skippedForUnreadableReference,
  };
};

/** Logs what a completion did beyond the status flip, the same way for both
 *  producers. Call it after the completing transaction commits. */
export const reportFinalizedReviewRun = (
  finalized: FinalizeReviewRunResult | { type: "deferred" },
  { workspaceId, runId }: ReviewRunRef,
): void => {
  if (finalized.type !== "completed") {
    return;
  }
  const fields = (value: number) => ({
    count: String(value),
    runId,
    workspaceId,
  });
  if (finalized.carried > 0) {
    logger.info(
      "document_review_run.decisions_carried",
      fields(finalized.carried),
    );
  }
  if (finalized.skippedForPendingLimit > 0) {
    logger.warn(
      "document_review_run.fixes_unstaged_pending_limit",
      fields(finalized.skippedForPendingLimit),
    );
  }
  if (finalized.skippedForUnreadableReference > 0) {
    logger.warn(
      "document_review_run.fixes_unstaged_unreadable_reference",
      fields(finalized.skippedForUnreadableReference),
    );
  }
};

/** Fails a run that is still queued or running. A terminal run is left as it
 *  is, so a late failure never overwrites a completion. */
export const failReviewRun = async (
  tx: Transaction,
  run: ReviewRunRef,
  errorCode: DocumentReviewRunErrorCode,
): Promise<void> => {
  await updateRunWhileIn(tx, run, DOCUMENT_REVIEW_RUN_ACTIVE_STATUSES, {
    status: "failed",
    errorCode,
    finishedAt: new Date(),
  });
};

/** Notes on a run which sources it read only in part. Every batch of a run reads
 *  the same document under the same model, so a later batch writes the same record. */
export const recordRunWithheldSources = async (
  tx: Transaction,
  run: ReviewRunRef,
  withheld: readonly ReviewWithheldSource[],
): Promise<void> => {
  await updateRunWhileIn(tx, run, DOCUMENT_REVIEW_RUN_ACTIVE_STATUSES, {
    withheldSources: [...withheld],
  });
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
 * completes the run anyway. Those matters are checked again inside the
 * transaction, under their lifecycle fence, because a deletion that overlaps
 * this write would otherwise miss the rows citing them.
 */
export const finalizeWorkerRun = async ({
  actor,
  basis,
  entityId,
  fileFieldId,
  expectedFindingCount,
}: FinalizeWorkerRunArgs): Promise<FinalizeReviewRunResult> => {
  const sourceDataWorkspaceIds = basisFixSourceWorkspaceIds(basis).filter(
    (referenceWorkspaceId) => referenceWorkspaceId !== actor.workspaceId,
  );
  const sourcesDb = await actor.writeDbWithReadableSources(
    sourceDataWorkspaceIds,
  );
  const writeDb = sourcesDb ?? actor.writeDb;
  return await writeDb(async (tx) => {
    const sourcesStand =
      sourcesDb !== null &&
      (await holdLiveSourceWorkspaces({
        tx,
        organizationId: actor.organizationId,
        workspaceIds: sourceDataWorkspaceIds,
      }));
    const fixStaging: ReviewFixStaging = sourcesStand
      ? { type: REVIEW_FIX_STAGING.stage, sourceDataWorkspaceIds }
      : { type: REVIEW_FIX_STAGING.withheld };
    return await finalizeReviewRun({
      tx,
      workspaceId: actor.workspaceId,
      runId: actor.runId,
      entityId,
      fileFieldId,
      executor: DOCUMENT_REVIEW_RUN_EXECUTOR.WORKER,
      fixStaging,
      expectedFindingCount,
    });
  });
};
