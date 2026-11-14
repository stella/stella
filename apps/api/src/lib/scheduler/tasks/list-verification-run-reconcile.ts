import { panic, Result } from "better-result";

import {
  reconcileQueuedFactExtractionRuns,
  reconcileStuckFactExtractionRuns,
} from "@/api/lib/lists/generation/run-queue";
import {
  reconcileQueuedListVerificationRuns,
  reconcileStuckListVerificationRuns,
} from "@/api/lib/lists/verification/run-queue";
import { SchedulerTaskFailure } from "@/api/lib/scheduler/types";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const featureAccess = {
  type: "required",
  featureId: "list-verification",
} as const;

export const RECONCILE_LIST_VERIFICATION_RUNS_TASK =
  "listVerifications.reconcileQueuedRuns" as const;

/**
 * Fail list verifications and fact extractions a dead worker left running,
 * then re-drive the ones the queue is not holding a job for anymore. Both run
 * kinds belong to the same feature and share one organization budget.
 */
export const reconcileListVerificationRuns: SchedulerTask = async ({
  db,
  logger,
  signal,
}) => {
  if (signal.aborted) {
    panic("SchedulerAborted");
  }
  const failed = await reconcileStuckListVerificationRuns(db);
  const queued = await reconcileQueuedListVerificationRuns({ db });
  const failedExtractions = await reconcileStuckFactExtractionRuns(db);
  const queuedExtractions = await reconcileQueuedFactExtractionRuns({ db });
  if (Result.isError(queued)) {
    return Result.err(
      new SchedulerTaskFailure({
        message: queued.error.message,
        cause: queued.error,
      }),
    );
  }
  if (Result.isError(queuedExtractions)) {
    return Result.err(
      new SchedulerTaskFailure({
        message: queuedExtractions.error.message,
        cause: queuedExtractions.error,
      }),
    );
  }
  const { handedOff, scanned, unattributed } = queued.value;
  logger.info("scheduler.list_verification_runs_reconciled", {
    "listVerificationRuns.failedStuck": failed,
    "listVerificationRuns.requeued": handedOff,
    "listVerificationRuns.scanned": scanned,
    "listVerificationRuns.unattributed": unattributed,
    "listFactExtractionRuns.failedStuck": failedExtractions,
    "listFactExtractionRuns.requeued": queuedExtractions.value.handedOff,
    "listFactExtractionRuns.scanned": queuedExtractions.value.scanned,
    "listFactExtractionRuns.unattributed": queuedExtractions.value.unattributed,
  });
  return Result.ok();
};
