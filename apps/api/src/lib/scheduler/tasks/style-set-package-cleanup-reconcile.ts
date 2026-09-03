import { panic } from "better-result";

import type { SchedulerTask } from "@/api/lib/scheduler/types";
import { reconcilePendingStyleSetPackageCleanups } from "@/api/lib/style-set-package-cleanup-queue";

export const RECONCILE_STYLE_SET_PACKAGE_CLEANUPS_TASK =
  "styleSets.reconcilePackageCleanups" as const;

/** Re-drive package deletions a style set row still records as owed. */
export const reconcileStyleSetPackageCleanups: SchedulerTask = async ({
  logger,
  signal,
}) => {
  if (signal.aborted) {
    panic("SchedulerAborted");
  }
  const { handedOff, scanned } =
    await reconcilePendingStyleSetPackageCleanups();
  logger.info("scheduler.style_set_package_cleanups_reconciled", {
    "styleSetPackageCleanups.enqueued": handedOff,
    "styleSetPackageCleanups.scanned": scanned,
  });
};
