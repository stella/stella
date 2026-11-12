import {
  reconcileQueuedFactExtractionRuns,
  reconcileStuckFactExtractionRuns,
} from "@/api/lib/lists/generation/run-queue";
import { listVerificationRunQueue } from "@/api/lib/lists/verification/run-queue";
import {
  asQueuedSweep,
  documentRunReconciler,
  documentRunReconcileTask,
  sweepDocumentRuns,
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
  async (db) =>
    // The two kinds sweep their own tables side by side.
    await Promise.all([
      sweepDocumentRuns(
        db,
        documentRunReconciler("listVerificationRuns", listVerificationRunQueue),
      ),
      sweepDocumentRuns(db, {
        key: "listFactExtractionRuns",
        reconcileStuck: async (runDb) =>
          await reconcileStuckFactExtractionRuns(runDb),
        reconcileQueued: async (runDb) =>
          asQueuedSweep(await reconcileQueuedFactExtractionRuns({ db: runDb })),
      }),
    ]),
);
