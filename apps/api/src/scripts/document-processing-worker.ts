import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";
import { detached } from "@/api/lib/detached";
import { countPendingDocumentProcessingJobs } from "@/api/lib/document-processing-enqueue";
import { initDocumentProcessingWorker } from "@/api/lib/document-processing-queue";
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
// cleanly once the queue has stayed empty for the whole window, so the
// task stops billing between batches.
const idleExitMinutes =
  envDocumentProcessingWorker.DOCUMENT_PROCESSING_IDLE_EXIT_MINUTES;
if (idleExitMinutes !== undefined) {
  const requiredIdleChecks = Math.max(
    1,
    Math.ceil((idleExitMinutes * 60_000) / IDLE_CHECK_INTERVAL_MS),
  );
  let consecutiveIdleChecks = 0;
  let idleCheckInFlight = false;
  const idleTimer = setInterval(() => {
    // A slow count must not overlap the next tick: reordered completions
    // could stitch two stale zero samples across a busy interval and exit
    // before the queue was continuously idle.
    if (idleCheckInFlight) {
      return;
    }
    idleCheckInFlight = true;
    detached(
      (async () => {
        const pending = await countPendingDocumentProcessingJobs().catch(
          (error: unknown) => {
            // A count failure (Redis hiccup) resets the streak: never exit
            // on uncertainty.
            logger.error("document_processing.idle_check_failed", {
              "error.type": errorTag(error),
            });
            return -1;
          },
        );
        idleCheckInFlight = false;
        consecutiveIdleChecks = pending === 0 ? consecutiveIdleChecks + 1 : 0;
        if (consecutiveIdleChecks < requiredIdleChecks || shuttingDown) {
          return;
        }
        clearInterval(idleTimer);
        logger.info("document_processing.idle_exit", {
          idleMinutes: idleExitMinutes,
        });
        await shutdown("idle-exit");
      })(),
      "document-processing.idle-exit-check",
    );
  }, IDLE_CHECK_INTERVAL_MS);
}
