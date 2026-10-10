import { panic } from "better-result";

import { rootDb } from "@/api/db/root";
import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";
import { detached } from "@/api/lib/analytics/capture";
import { createBullMqWorkerHost } from "@/api/lib/bullmq-queue";
import { countPendingDocumentProcessingJobs } from "@/api/lib/document-processing-enqueue";
import {
  createIdleExitCheck,
  IDLE_EXIT_REASON,
} from "@/api/lib/document-processing-idle-exit";
import type { IdleExitReason } from "@/api/lib/document-processing-idle-exit";
import {
  documentProcessingReconciliationGeneration,
  documentProcessingUnfinishedReconciliationPhases,
  hasUnfinishedDocumentProcessingReconciliation,
  initDocumentProcessingWorker,
  isDocumentProcessingReconciliationInFlight,
} from "@/api/lib/document-processing-queue";
import { errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import type { LoggerAttributes } from "@/api/lib/observability/logger";
import { refreshS3 } from "@/api/lib/s3";

const IDLE_CHECK_INTERVAL_MS = 60_000;
// Well inside the interval, so a sample stuck on a hung read ends before
// the next tick would have to skip it.
const IDLE_SAMPLE_TIMEOUT_MS = 20_000;
// How long a quiet queue may be held open by reconciliation alone before
// the worker exits anyway and leaves the rest to the next start.
const IDLE_EXIT_QUIET_CAP_MINUTES = 60;

const idleChecksFor = (minutes: number): number =>
  Math.max(1, Math.ceil((minutes * 60_000) / IDLE_CHECK_INTERVAL_MS));

/**
 * What reconciliation is holding the exit for, as log fields: the phases
 * the latest finished tick reported as unfinished, whether that tick
 * reported at all, and whether another is running now.
 */
const reconciliationHoldFields = (): LoggerAttributes => {
  const report = documentProcessingUnfinishedReconciliationPhases();
  const reconciliationInFlight = String(
    isDocumentProcessingReconciliationInFlight(),
  );
  switch (report.status) {
    case "failed":
    case "none":
      return {
        latestReconciliationTick: report.status,
        reconciliationInFlight,
        unfinishedPhases: "",
      };
    case "reported":
      return {
        latestReconciliationTick: report.status,
        reconciliationInFlight,
        unfinishedPhases: report.unfinishedPhases.join(","),
      };
    default:
      report satisfies never;
      return panic(`Unhandled reconciliation report: ${String(report)}`);
  }
};

const idleExitFields = (reason: IdleExitReason): LoggerAttributes => {
  switch (reason) {
    case IDLE_EXIT_REASON.IDLE:
      return { reason };
    case IDLE_EXIT_REASON.QUIET_CAP:
      return { reason, ...reconciliationHoldFields() };
    default:
      reason satisfies never;
      return panic(`Unhandled idle exit reason: ${String(reason)}`);
  }
};

await refreshS3();
// The host owns the root connection and hands it to its worker.
const documentProcessingWorkers = createBullMqWorkerHost(
  "document-processing-worker",
  { db: rootDb },
  envDocumentProcessingWorker.SCHEDULED_JOBS_MODE,
  [initDocumentProcessingWorker],
);

let shuttingDown = false;
let stopIdleSampling: (() => void) | null = null;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  stopIdleSampling?.();
  logger.info("document_processing.shutdown_started", { signal });
  await documentProcessingWorkers.close();
  process.exit(0);
};

process.once("SIGTERM", () => {
  detached(shutdown("SIGTERM"), "document-processing.shutdown-sigterm");
});
process.once("SIGINT", () => {
  detached(shutdown("SIGINT"), "document-processing.shutdown-sigint");
});

// Batch mode: when an idle-exit window is configured (the scheduled batch
// task sets it; long-running deployments leave it unset), the worker exits
// cleanly once the queue has stayed empty and reconciliation has stopped
// finding work for the whole window, so the task stops billing between
// batches without abandoning a backlog mid-drain. A queue that stays quiet
// for the longer quiet cap exits even while reconciliation holds on: its
// progress is durable, so the next start picks it up.
const idleExitMinutes =
  envDocumentProcessingWorker.DOCUMENT_PROCESSING_IDLE_EXIT_MINUTES;
if (idleExitMinutes !== undefined) {
  const requiredIdleChecks = idleChecksFor(idleExitMinutes);
  const maxQuietChecks = Math.max(
    requiredIdleChecks,
    idleChecksFor(IDLE_EXIT_QUIET_CAP_MINUTES),
  );
  const idleTick = createIdleExitCheck({
    countPending: countPendingDocumentProcessingJobs,
    hasUnfinishedReconciliation: hasUnfinishedDocumentProcessingReconciliation,
    isReconciliationInFlight: isDocumentProcessingReconciliationInFlight,
    reconciliationGeneration: documentProcessingReconciliationGeneration,
    maxQuietChecks,
    requiredIdleChecks,
    sampleTimeoutMs: IDLE_SAMPLE_TIMEOUT_MS,
    onCheckFailure: (error) => {
      logger.error("document_processing.idle_check_failed", {
        "error.type": errorTag(error),
      });
    },
    onReconciliationHold: () => {
      logger.info("document_processing.idle_exit_held", {
        idleMinutes: idleExitMinutes,
        quietCapMinutes: IDLE_EXIT_QUIET_CAP_MINUTES,
        ...reconciliationHoldFields(),
      });
    },
    onIdleExit: (reason) => {
      stopIdleSampling?.();
      if (shuttingDown) {
        return;
      }
      logger.info("document_processing.idle_exit", {
        idleMinutes: idleExitMinutes,
        ...idleExitFields(reason),
      });
      detached(shutdown("idle-exit"), "document-processing.idle-exit");
    },
  });
  const idleTimer = setInterval(() => {
    detached(idleTick(), "document-processing.idle-exit-check");
  }, IDLE_CHECK_INTERVAL_MS);
  stopIdleSampling = () => {
    clearInterval(idleTimer);
  };
}
