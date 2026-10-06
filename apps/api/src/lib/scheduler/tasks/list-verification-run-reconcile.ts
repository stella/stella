import { panic, Result } from "better-result";

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
 * Fail list verifications a dead worker left running, then re-drive the ones
 * the queue is not holding a job for anymore.
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
  if (Result.isError(queued)) {
    return Result.err(
      new SchedulerTaskFailure({
        message: queued.error.message,
        cause: queued.error,
      }),
    );
  }
  const { handedOff, scanned, unattributed } = queued.value;
  logger.info("scheduler.list_verification_runs_reconciled", {
    "listVerificationRuns.failedStuck": failed,
    "listVerificationRuns.requeued": handedOff,
    "listVerificationRuns.scanned": scanned,
    "listVerificationRuns.unattributed": unattributed,
  });
  return Result.ok();
};
