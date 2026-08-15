import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";
import { detached } from "@/api/lib/detached";
import { countPendingDocumentProcessingJobs } from "@/api/lib/document-processing-enqueue";
import { createIdleExitCheck } from "@/api/lib/document-processing-idle-exit";
import {
  hasUnfinishedDocumentProcessingReconciliation,
  initDocumentProcessingWorker,
} from "@/api/lib/document-processing-queue";
import { errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { refreshS3 } from "@/api/lib/s3";

const IDLE_CHECK_INTERVAL_MS = 60_000;

await refreshS3();
const documentProcessingWorker = initDocumentProcessingWorker();

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info("document_processing.shutdown_started", { signal });
  try {
    await documentProcessingWorker.close();
  } catch (error) {
    logger.error("document_processing.shutdown_failed", {
      "error.type": errorTag(error),
    });
  }
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
// batches without abandoning a backlog mid-drain.
const idleExitMinutes =
  envDocumentProcessingWorker.DOCUMENT_PROCESSING_IDLE_EXIT_MINUTES;
if (idleExitMinutes !== undefined) {
  const requiredIdleChecks = Math.max(
    1,
    Math.ceil((idleExitMinutes * 60_000) / IDLE_CHECK_INTERVAL_MS),
  );
  let idleTimer: ReturnType<typeof setInterval> | null = null;
  const idleTick = createIdleExitCheck({
    countPending: countPendingDocumentProcessingJobs,
    hasUnfinishedReconciliation: hasUnfinishedDocumentProcessingReconciliation,
    requiredIdleChecks,
    onCheckFailure: (error) => {
      logger.error("document_processing.idle_check_failed", {
        "error.type": errorTag(error),
      });
    },
    onIdleExit: () => {
      if (idleTimer !== null) {
        clearInterval(idleTimer);
      }
      if (shuttingDown) {
        return;
      }
      logger.info("document_processing.idle_exit", {
        idleMinutes: idleExitMinutes,
      });
      detached(shutdown("idle-exit"), "document-processing.idle-exit");
    },
  });
  idleTimer = setInterval(() => {
    detached(idleTick(), "document-processing.idle-exit-check");
  }, IDLE_CHECK_INTERVAL_MS);
}
