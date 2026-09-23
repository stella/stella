import { panic } from "better-result";

import { reconcileQueuedListVerificationRuns } from "@/api/lib/lists/verification/run-queue";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const RECONCILE_LIST_VERIFICATION_RUNS_TASK =
  "listVerifications.reconcileQueuedRuns" as const;

/** Re-drive list verifications the queue is not holding a job for anymore. */
export const reconcileListVerificationRuns: SchedulerTask = async ({
  logger,
  signal,
}) => {
  if (signal.aborted) {
    panic("SchedulerAborted");
  }
  const { handedOff, scanned, unattributed } =
    await reconcileQueuedListVerificationRuns();
  logger.info("scheduler.list_verification_runs_reconciled", {
    "listVerificationRuns.requeued": handedOff,
    "listVerificationRuns.scanned": scanned,
    "listVerificationRuns.unattributed": unattributed,
  });
};
