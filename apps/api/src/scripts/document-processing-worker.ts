import { detached } from "@/api/lib/detached";
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
