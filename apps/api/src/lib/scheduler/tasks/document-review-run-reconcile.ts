import { panic } from "better-result";

import { reconcileQueuedDocumentReviewRuns } from "@/api/lib/document-review/run-queue";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const RECONCILE_DOCUMENT_REVIEW_RUNS_TASK =
  "documentReviews.reconcileQueuedRuns" as const;

/** Re-drive review runs the queue is not holding a job for anymore. */
export const reconcileDocumentReviewRuns: SchedulerTask = async ({
  logger,
  signal,
}) => {
  if (signal.aborted) {
    panic("SchedulerAborted");
  }
  const { handedOff, scanned, unattributed } =
    await reconcileQueuedDocumentReviewRuns();
  logger.info("scheduler.document_review_runs_reconciled", {
    "documentReviewRuns.requeued": handedOff,
    "documentReviewRuns.scanned": scanned,
    "documentReviewRuns.unattributed": unattributed,
  });
};
