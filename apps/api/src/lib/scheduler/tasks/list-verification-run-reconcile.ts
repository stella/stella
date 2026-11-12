import {
  reconcileQueuedFactExtractionRuns,
  reconcileStuckFactExtractionRuns,
} from "@/api/lib/lists/generation/run-queue";
import { listVerificationRunQueue } from "@/api/lib/lists/verification/run-queue";
import {
  asQueuedSweep,
  documentRunReconciler,
  documentRunReconcileTask,
} from "@/api/lib/queue/document-run-reconcile";

export const featureAccess = {
  type: "required",
  featureId: "list-verification",
} as const;

export const RECONCILE_LIST_VERIFICATION_RUNS_TASK =
  "listVerifications.reconcileQueuedRuns" as const;

/**
 * Fail list verifications and fact extractions a dead worker left running,
 * then re-drive the ones the queue is not holding a job for anymore. Both run
 * kinds belong to the same feature and share one organization budget.
 */
export const reconcileListVerificationRuns = documentRunReconcileTask(
  "scheduler.list_verification_runs_reconciled",
  [
    documentRunReconciler("listVerificationRuns", listVerificationRunQueue),
    {
      key: "listFactExtractionRuns",
      reconcileStuck: async (db) => await reconcileStuckFactExtractionRuns(db),
      reconcileQueued: async (db) =>
        asQueuedSweep(await reconcileQueuedFactExtractionRuns({ db })),
    },
  ],
);
