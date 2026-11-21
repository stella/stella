import { panic, Result } from "better-result";

import { sanitizeErrorAttributesForOutput } from "@stll/errors";

import type { RequeueableQueue } from "@/api/lib/bullmq-requeue";
import { errorTag } from "@/api/lib/errors/error-tag";
import type { ReportExportJobData } from "@/api/lib/report-export-enqueue";
import {
  getReportExportQueue,
  reconcileQueuedReportExports,
} from "@/api/lib/report-export-enqueue";
import { recoverStuckReportExports } from "@/api/lib/report-export-recovery";
import type { StuckExportJobQueue } from "@/api/lib/report-export-recovery";
import type { SchedulerTask } from "@/api/lib/scheduler/types";
import { SchedulerTaskFailure } from "@/api/lib/scheduler/types";

export const RECONCILE_REPORT_EXPORTS_TASK =
  "reportExports.reconcileQueued" as const;

/**
 * Re-drive report exports the queue is not holding a job for anymore.
 *
 * The staleness janitor runs first: an export that has sat `queued` past its
 * threshold has already outlived every requeue this sweep could give it, and
 * failing it first keeps the reconciler from handing back a job for a row the
 * same tick is about to close.
 */
type ReportExportReconcileDependencies = {
  queue?: RequeueableQueue<ReportExportJobData> & StuckExportJobQueue;
};

export const createReconcileReportExportsTask =
  ({ queue }: ReportExportReconcileDependencies = {}): SchedulerTask =>
  async ({ db, logger, signal }) => {
    if (signal.aborted) {
      panic("SchedulerAborted");
    }
    const reportQueue = queue ?? getReportExportQueue();
    const recovery = await recoverStuckReportExports({
      db,
      queue: reportQueue,
    });
    const requeue = await reconcileQueuedReportExports({
      db,
      queue: reportQueue,
    });
    const recoverySummary = Result.isError(recovery)
      ? recovery.error.summary
      : recovery.value;
    const requeueSummary = Result.isError(requeue)
      ? requeue.error.summary
      : requeue.value;
    logger.info(
      "scheduler.report_exports_reconciled",
      sanitizeErrorAttributesForOutput({
        "reportExports.failed": recoverySummary.failed + requeueSummary.failed,
        "reportExports.recovered": recoverySummary.recovered,
        "reportExports.requeued": requeueSummary.handedOff,
        "reportExports.scanned": requeueSummary.scanned,
        "reportExports.unattributed": requeueSummary.unattributed,
        "reportExports.unrecoverable": requeueSummary.unrecoverable,
      }),
    );
    if (Result.isError(recovery)) {
      if (Result.isError(requeue)) {
        // The runner captures one cause per tick: the inspection failure,
        // since it ran first. The requeue stage keeps its own diagnosis here
        // instead of a second capture.
        logger.warn(
          "report_export.requeue_stage_failed",
          sanitizeErrorAttributesForOutput({
            "error.type": errorTag(requeue.error.cause),
            "reportExports.failed": requeue.error.summary.failed,
          }),
        );
      }
      return Result.err(
        new SchedulerTaskFailure({
          cause: recovery.error,
          message: Result.isError(requeue)
            ? `${recovery.error.message}; ${requeue.error.message}`
            : recovery.error.message,
        }),
      );
    }
    if (Result.isError(requeue)) {
      return Result.err(
        new SchedulerTaskFailure({
          cause: requeue.error,
          message: requeue.error.message,
        }),
      );
    }
    return Result.ok(undefined);
  };

export const reconcileReportExports = createReconcileReportExportsTask();
