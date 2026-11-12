import { documentReviewRunQueue } from "@/api/lib/document-review/run-queue";
import {
  documentRunReconciler,
  documentRunReconcileTask,
} from "@/api/lib/queue/document-run-reconcile";

export const RECONCILE_DOCUMENT_REVIEW_RUNS_TASK =
  "documentReviews.reconcileQueuedRuns" as const;

/** Fail stuck document reviews and re-drive the ones no job owns anymore. */
export const reconcileDocumentReviewRuns = documentRunReconcileTask(
  "scheduler.document_review_runs_reconciled",
  [documentRunReconciler("documentReviewRuns", documentReviewRunQueue)],
);
