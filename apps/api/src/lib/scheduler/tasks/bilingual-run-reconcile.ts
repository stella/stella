import { panic } from "better-result";

import { reconcileQueuedBilingualRuns } from "@/api/lib/bilingual/run-queue";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const RECONCILE_BILINGUAL_RUNS_TASK =
  "bilingualTranslations.reconcileQueuedRuns" as const;

/** Re-drive bilingual runs the queue is not holding a job for anymore. */
export const reconcileBilingualRuns: SchedulerTask = async ({
  logger,
  signal,
}) => {
  if (signal.aborted) {
    panic("SchedulerAborted");
  }
  const { handedOff, scanned, unattributed } =
    await reconcileQueuedBilingualRuns();
  logger.info("scheduler.bilingual_runs_reconciled", {
    "bilingualRuns.requeued": handedOff,
    "bilingualRuns.scanned": scanned,
    "bilingualRuns.unattributed": unattributed,
  });
};
