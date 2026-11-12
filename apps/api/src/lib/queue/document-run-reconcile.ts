/**
 * The scheduler sweep every document run queue shares: fail the runs a dead
 * worker or a lost job left behind, then hand back the queued runs no job
 * owns. Each queue's reconcile task is built here from its queue, so the
 * sweeps cannot drift apart; each task module keeps only its own feature
 * gating and which run kinds it sweeps.
 */

import { panic, Result } from "better-result";

import type { ReconcileQueuedRunsResult } from "@/api/lib/queue/reconcile-scan";
import { SchedulerTaskFailure } from "@/api/lib/scheduler/types";
import type { SchedulerDb, SchedulerTask } from "@/api/lib/scheduler/types";

type QueuedSweep = Result<ReconcileQueuedRunsResult, SchedulerTaskFailure>;

/** One kind of run a reconcile task sweeps, keyed by its log prefix. */
type RunReconciler = {
  key: string;
  /** Fails the runs a dead worker or a lost job left behind. */
  reconcileStuck: (db: SchedulerDb) => Promise<number>;
  /** Hands `queued` runs no job owns back to their queue. */
  reconcileQueued: (db: SchedulerDb) => Promise<QueuedSweep>;
};

/** A queued sweep's failure, as the scheduler records it. */
export const asQueuedSweep = <E extends Error>(
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
export const documentRunReconciler = <E extends Error>(
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
export const documentRunReconcileTask =
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
