import { rootDb } from "@/api/db/root";
import { initReportExportWorker } from "@/api/handlers/reports/report-export-queue";
import { initAccountDeletionCleanupWorker } from "@/api/lib/account-deletion-cleanup-queue";
import { initBilingualRunWorker } from "@/api/lib/bilingual/run-queue";
import { createBullMqWorkerHost } from "@/api/lib/bullmq-queue";
import { initDocumentDeadlineScoutWorker } from "@/api/lib/document-deadline-scout-worker";
import { initDocumentReviewRunWorker } from "@/api/lib/document-review/run-queue";
import { initDocumentTranslationRunWorker } from "@/api/lib/document-translation/run-queue";
import { initEntityDeletionCleanupWorker } from "@/api/lib/entity-deletion-cleanup-queue";
import { initFileDerivativeWorker } from "@/api/lib/file-derivative-queue";
import { initFlowRunWorker } from "@/api/lib/flows/flow-run-worker";
import { initStyleSetPackageCleanupWorker } from "@/api/lib/style-set-package-cleanup-queue";
import { initWorkflowWorkers } from "@/api/lib/workflow-queue";

/**
 * The workers the HTTP server hosts in-process. The host check holds this
 * list to exactly the queues `BULLMQ_QUEUE_HOSTS` assigns to `api`, using the
 * queue names each starter reports, so a queue cannot be declared without
 * the worker that drains it being started and closed here. The host owns the
 * root connection and hands it to every worker.
 */
export const initApiBackgroundWorkers = () =>
  createBullMqWorkerHost("api", { db: rootDb }, [
    initAccountDeletionCleanupWorker,
    initBilingualRunWorker,
    initDocumentDeadlineScoutWorker,
    initDocumentReviewRunWorker,
    initDocumentTranslationRunWorker,
    initEntityDeletionCleanupWorker,
    initFileDerivativeWorker,
    initFlowRunWorker,
    initReportExportWorker,
    initStyleSetPackageCleanupWorker,
    initWorkflowWorkers,
  ]);
