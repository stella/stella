/**
 * The scheduler sweep every document run queue shares: fail the runs a dead
 * worker or a lost job left behind, then hand back the queued runs no job
 * owns. Each queue's reconcile task is built here from its queue, so the
 * sweeps cannot drift apart; each task module keeps only its own feature
 * gating and which run kinds it sweeps.
 */

import { panic, Result } from "better-result";

import type { ReconcileQueuedRunsResult } from "@/api/lib/queue-reconcile-scan";
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

type RunSweep = {
  key: string;
  failedStuck: Result<number, SchedulerTaskFailure>;
  queued: QueuedSweep;
};

/**
 * One kind's sweep: fail its stuck runs, then re-drive the queued runs its
 * queue no longer holds a job for. The stuck sweep runs first, so a run it
 * fails is never handed back. A phase that rejects is recorded as that
 * phase's failure and the other phase still runs.
 */
export const sweepDocumentRuns = async (
  db: SchedulerDb,
  reconciler: RunReconciler,
): Promise<RunSweep> => {
  const phaseFailure = (phase: string) => (cause: unknown) =>
    new SchedulerTaskFailure({
      message: `${reconciler.key} ${phase} sweep failed`,
      cause,
    });
  const failedStuck = await Result.tryPromise({
    try: async () => await reconciler.reconcileStuck(db),
    catch: phaseFailure("stuck"),
  });
  const queued = Result.flatten(
    await Result.tryPromise({
      try: async () => await reconciler.reconcileQueued(db),
      catch: phaseFailure("queued"),
    }),
  );
  return { key: reconciler.key, failedStuck, queued };
};

/**
 * A reconcile task over the kinds its `sweep` covers, each through
 * `sweepDocumentRuns`. Every kind finishes before a failure is reported, so
 * one broken queue does not cost the others their sweep.
 */
export const documentRunReconcileTask =
  (
    event: string,
    sweep: (db: SchedulerDb) => Promise<readonly RunSweep[]>,
  ): SchedulerTask =>
  async ({ db, logger, signal }) => {
    if (signal.aborted) {
      panic("SchedulerAborted");
    }
    const swept = await sweep(db);
    const counts: [string, number][] = [];
    const failures: SchedulerTaskFailure[] = [];
    for (const { key, failedStuck, queued } of swept) {
      if (Result.isError(failedStuck)) {
        failures.push(failedStuck.error);
      } else {
        counts.push([`${key}.failedStuck`, failedStuck.value]);
      }
      if (Result.isError(queued)) {
        failures.push(queued.error);
      } else {
        const { handedOff, scanned, unattributed } = queued.value;
        counts.push(
          [`${key}.requeued`, handedOff],
          [`${key}.scanned`, scanned],
          [`${key}.unattributed`, unattributed],
        );
      }
    }
    logger.info(event, Object.fromEntries(counts));
    if (failures.length === 0) {
      return Result.ok();
    }
    // Every phase that failed is reported, not only the first.
    return Result.err(
      failures.length === 1
        ? (failures.at(0) ?? panic("A recorded failure is missing"))
        : new SchedulerTaskFailure({
            message: failures.map(({ message }) => message).join("; "),
            cause: failures,
          }),
    );
  };
