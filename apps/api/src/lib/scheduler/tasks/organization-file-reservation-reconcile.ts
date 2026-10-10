import { panic } from "better-result";

import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { reconcileAbandonedOrganizationFileReservations } from "@/api/lib/files/organization-file-usage-reconcile";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const RECONCILE_ORGANIZATION_FILE_RESERVATIONS_TASK =
  "files.reconcileReservations" as const;

type ReconcileDependencies = {
  reconcile?: typeof reconcileAbandonedOrganizationFileReservations;
};

export const createReconcileOrganizationFileReservationsTask =
  ({
    reconcile = reconcileAbandonedOrganizationFileReservations,
  }: ReconcileDependencies = {}): SchedulerTask =>
  async ({ db, logger, signal }) => {
    if (!isDeploymentFeatureEnabled("FEATURE_FILE_USAGE_LIMITS")) {
      return;
    }
    if (signal.aborted) {
      panic("SchedulerAborted");
    }
    const settled = (await reconcile({ db, signal })).unwrap(
      "Reservation reconciliation must succeed before this task completes",
    );
    logger.info("scheduler.organization_file_reservations_reconciled", {
      "fileReservations.scanned": settled.scanned,
      "fileReservations.committed": settled.committed,
      "fileReservations.deleted": settled.deleted,
      "fileReservations.released": settled.released,
      "fileReservations.mismatched": settled.mismatched,
    });
    if (settled.mismatched > 0) {
      logger.warn("scheduler.organization_file_reservations_mismatched", {
        "fileReservations.mismatched": settled.mismatched,
      });
    }
  };

export const reconcileOrganizationFileReservations =
  createReconcileOrganizationFileReservationsTask();
