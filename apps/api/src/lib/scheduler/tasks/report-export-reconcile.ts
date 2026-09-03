import { panic } from "better-result";

import {
  getReportExportQueue,
  reconcileQueuedReportExports,
} from "@/api/lib/report-export-enqueue";
import { recoverStuckReportExports } from "@/api/lib/report-export-recovery";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

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
export const reconcileReportExports: SchedulerTask = async ({
  logger,
  signal,
}) => {
  if (signal.aborted) {
    panic("SchedulerAborted");
  }
  const recovered = await recoverStuckReportExports({
    queue: getReportExportQueue(),
  });
  const { handedOff, scanned, unattributed, unrecoverable } =
    await reconcileQueuedReportExports();
  logger.info("scheduler.report_exports_reconciled", {
    "reportExports.recovered": recovered,
    "reportExports.requeued": handedOff,
    "reportExports.scanned": scanned,
    "reportExports.unattributed": unattributed,
    "reportExports.unrecoverable": unrecoverable,
  });
};
