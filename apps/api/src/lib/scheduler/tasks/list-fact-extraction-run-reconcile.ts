import { panic, Result } from "better-result";

import {
  reconcileQueuedFactExtractionRuns,
  reconcileStuckFactExtractionRuns,
} from "@/api/lib/lists/generation/run-queue";
import { SchedulerTaskFailure } from "@/api/lib/scheduler/types";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const featureAccess = {
  type: "required",
  featureId: "list-verification",
} as const;

export const RECONCILE_FACT_EXTRACTION_RUNS_TASK =
  "listFactExtractions.reconcileQueuedRuns" as const;

/**
 * Fail fact extractions a dead worker left running, then re-drive the ones
 * the queue is not holding a job for anymore.
 */
export const reconcileFactExtractionRuns: SchedulerTask = async ({
  db,
  logger,
  signal,
}) => {
  if (signal.aborted) {
    panic("SchedulerAborted");
  }
  const failed = await reconcileStuckFactExtractionRuns(db);
  const queued = await reconcileQueuedFactExtractionRuns({ db });
  if (Result.isError(queued)) {
    return Result.err(
      new SchedulerTaskFailure({
        message: queued.error.message,
        cause: queued.error,
      }),
    );
  }
  const { handedOff, scanned, unattributed } = queued.value;
  logger.info("scheduler.list_fact_extraction_runs_reconciled", {
    "listFactExtractionRuns.failedStuck": failed,
    "listFactExtractionRuns.requeued": handedOff,
    "listFactExtractionRuns.scanned": scanned,
    "listFactExtractionRuns.unattributed": unattributed,
  });
  return Result.ok();
};
