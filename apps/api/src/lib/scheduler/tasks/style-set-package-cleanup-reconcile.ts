import { panic, Result } from "better-result";

import { sanitizeErrorAttributesForOutput } from "@stll/errors";

import type { SchedulerTask } from "@/api/lib/scheduler/types";
import { SchedulerTaskFailure } from "@/api/lib/scheduler/types";
import { reconcilePendingStyleSetPackageCleanups } from "@/api/lib/style-set-package-cleanup-queue";

export const RECONCILE_STYLE_SET_PACKAGE_CLEANUPS_TASK =
  "styleSets.reconcilePackageCleanups" as const;

type StyleSetPackageCleanupReconcileDependencies = {
  cleanupQueue?: Parameters<
    typeof reconcilePendingStyleSetPackageCleanups
  >[0]["cleanupQueue"];
};

/** Re-drive package deletions a style set row still records as owed. */
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
    const summary = Result.isError(outcome)
      ? outcome.error.summary
      : outcome.value;
    logger.info(
      "scheduler.style_set_package_cleanups_reconciled",
      sanitizeErrorAttributesForOutput({
        "styleSetPackageCleanups.enqueued": summary.handedOff,
        "styleSetPackageCleanups.failed": summary.failed,
        "styleSetPackageCleanups.scanned": summary.scanned,
      }),
    );
    if (Result.isError(outcome)) {
      return Result.err(
        new SchedulerTaskFailure({
          cause: outcome.error,
          message: outcome.error.message,
        }),
      );
    }
    return Result.ok(undefined);
  };

export const reconcileStyleSetPackageCleanups =
  createReconcileStyleSetPackageCleanupsTask();
