import { panic, Result } from "better-result";

import { sanitizeErrorAttributesForOutput } from "@stll/errors";

import type { SchedulerTask } from "@/api/lib/scheduler/types";
import { SchedulerTaskFailure } from "@/api/lib/scheduler/types";
import {
  reconcileDeletedStyleSetPackages,
  reconcilePendingStyleSetPackageCleanups,
} from "@/api/lib/style-set-package-cleanup-queue";

export const RECONCILE_STYLE_SET_PACKAGE_CLEANUPS_TASK =
  "styleSets.reconcilePackageCleanups" as const;

type StyleSetPackageCleanupReconcileDependencies = {
  cleanupQueue?: Parameters<
    typeof reconcilePendingStyleSetPackageCleanups
  >[0]["cleanupQueue"];
};

/** Re-drive replacement cleanup and consume committed deletion tombstones. */
export const createReconcileStyleSetPackageCleanupsTask =
  ({
    cleanupQueue,
  }: StyleSetPackageCleanupReconcileDependencies = {}): SchedulerTask =>
  async ({ db, logger, signal }) => {
    if (signal.aborted) {
      panic("SchedulerAborted");
    }
    const outcome = await reconcilePendingStyleSetPackageCleanups({
      ...(cleanupQueue === undefined ? {} : { cleanupQueue }),
      db,
    });
    const deletionOutcome = await reconcileDeletedStyleSetPackages({ db });
    const summary = Result.isError(outcome)
      ? outcome.error.summary
      : outcome.value;
    const deletionSummary = Result.isError(deletionOutcome)
      ? deletionOutcome.error.summary
      : deletionOutcome.value;
    logger.info(
      "scheduler.style_set_package_cleanups_reconciled",
      sanitizeErrorAttributesForOutput({
        "styleSetDeletionCleanups.cleaned": deletionSummary.cleaned,
        "styleSetDeletionCleanups.failed": deletionSummary.failed,
        "styleSetDeletionCleanups.scanned": deletionSummary.scanned,
        "styleSetPackageCleanups.enqueued": summary.handedOff,
        "styleSetPackageCleanups.failed": summary.failed,
        "styleSetPackageCleanups.scanned": summary.scanned,
      }),
    );
    let error = null;
    if (Result.isError(outcome)) {
      error = outcome.error;
    } else if (Result.isError(deletionOutcome)) {
      error = deletionOutcome.error;
    }
    if (error !== null) {
      return Result.err(
        new SchedulerTaskFailure({
          cause: error,
          message: error.message,
        }),
      );
    }
    return Result.ok(undefined);
  };

export const reconcileStyleSetPackageCleanups =
  createReconcileStyleSetPackageCleanupsTask();
