import { panic, Result } from "better-result";

import { documentReviewRunQueue } from "@/api/lib/document-review/run-queue";
import {
  reconcileQueuedFactExtractionRuns,
  reconcileStuckFactExtractionRuns,
} from "@/api/lib/lists/generation/run-queue";
import { listVerificationRunQueue } from "@/api/lib/lists/verification/run-queue";
import type { ReconcileQueuedRunsResult } from "@/api/lib/queue/reconcile-scan";
import { SchedulerTaskFailure } from "@/api/lib/scheduler/types";
import type { SchedulerDb, SchedulerTask } from "@/api/lib/scheduler/types";

export const RECONCILE_DOCUMENT_REVIEW_RUNS_TASK =
  "documentReviews.reconcileQueuedRuns" as const;

export const RECONCILE_LIST_VERIFICATION_RUNS_TASK =
  "listVerifications.reconcileQueuedRuns" as const;

type QueuedSweep = Result<ReconcileQueuedRunsResult, SchedulerTaskFailure>;

/** One kind of run a reconcile task sweeps, keyed by its log prefix. */
type RunReconciler = {
  key: string;
  /** Fails the runs a dead worker or a lost job left behind. */
  reconcileStuck: (db: SchedulerDb) => Promise<number>;
  /** Hands `queued` runs no job owns back to their queue. */
  reconcileQueued: (db: SchedulerDb) => Promise<QueuedSweep>;
};

const asQueuedSweep = <E extends Error>(
  queued: Result<ReconcileQueuedRunsResult, E>,
): QueuedSweep =>
  Result.isError(queued)
    ? Result.err(
        new SchedulerTaskFailure({
          message: queued.error.message,
          cause: queued.error,
        }),
      )
    : Result.ok(queued.value);

/** A queue built by `createDocumentRunQueue`, swept with its own rules. */
const documentRunReconciler = <E extends Error>(
  key: string,
  queue: {
    reconcileStuck: (args: { db: SchedulerDb }) => Promise<number>;
    reconcileQueued: (args: {
      db: SchedulerDb;
    }) => Promise<Result<ReconcileQueuedRunsResult, E>>;
  },
): RunReconciler => ({
  key,
  reconcileStuck: async (db) => await queue.reconcileStuck({ db }),
  reconcileQueued: async (db) =>
    asQueuedSweep(await queue.reconcileQueued({ db })),
});

/**
 * One task over the run kinds it is given: each kind fails its stuck runs,
 * then re-drives the queued runs its queue no longer holds a job for. Every
 * kind is swept before a failure is reported, so one broken queue does not
 * cost the others their sweep.
 */
const documentRunReconcileTask =
  (event: string, reconcilers: readonly RunReconciler[]): SchedulerTask =>
  async ({ db, logger, signal }) => {
    if (signal.aborted) {
      panic("SchedulerAborted");
    }
    const swept: { key: string; failedStuck: number; queued: QueuedSweep }[] =
      [];
    for (const reconciler of reconcilers) {
      swept.push({
        key: reconciler.key,
        failedStuck: await reconciler.reconcileStuck(db),
        queued: await reconciler.reconcileQueued(db),
      });
    }
    const counts: [string, number][] = [];
    for (const { key, failedStuck, queued } of swept) {
      if (Result.isError(queued)) {
        return Result.err(queued.error);
      }
      const { handedOff, scanned, unattributed } = queued.value;
      counts.push(
        [`${key}.failedStuck`, failedStuck],
        [`${key}.requeued`, handedOff],
        [`${key}.scanned`, scanned],
        [`${key}.unattributed`, unattributed],
      );
    }
    logger.info(event, Object.fromEntries(counts));
    return Result.ok();
  };

/** Fail stuck document reviews and re-drive the ones no job owns anymore. */
export const reconcileDocumentReviewRuns = documentRunReconcileTask(
  "scheduler.document_review_runs_reconciled",
  [documentRunReconciler("documentReviewRuns", documentReviewRunQueue)],
);

/**
 * The same for list verifications, and for fact extractions, which belong to
 * the same feature and share one organization budget.
 */
export const reconcileListVerificationRuns = documentRunReconcileTask(
  "scheduler.list_verification_runs_reconciled",
  [
    documentRunReconciler("listVerificationRuns", listVerificationRunQueue),
    {
      key: "listFactExtractionRuns",
      reconcileStuck: async (db) => await reconcileStuckFactExtractionRuns(db),
      reconcileQueued: async (db) =>
        asQueuedSweep(await reconcileQueuedFactExtractionRuns({ db })),
    },
  ],
);
