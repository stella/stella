import { initDocumentProcessingWorker } from "@/api/lib/document-processing-queue";
import { errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { refreshS3 } from "@/api/lib/s3";

await refreshS3();
const documentProcessingWorker = initDocumentProcessingWorker();

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info("document_processing.shutdown_started", { signal });
  await documentProcessingWorker.close().catch((error: unknown) => {
    logger.error("document_processing.shutdown_failed", {
      "error.type": errorTag(error),
    });
  });
  process.exit(0);
};

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
