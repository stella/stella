import { Worker } from "bullmq";

import { captureError } from "@/api/lib/analytics/capture";
import {
  DEADLINE_SCOUT_JOB_NAME,
  DEADLINE_SCOUT_QUEUE_NAME,
  type DocumentDeadlineScoutJobData,
} from "@/api/lib/document-processing-enqueue";
import { errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { createQueueWorkerErrorLogger } from "@/api/lib/queue-worker-error-log";
import { createBullMqConnection } from "@/api/lib/redis-client";

const DEADLINE_SCOUT_WORKER_CONCURRENCY = 1;

export const initDocumentDeadlineScoutWorker = () => {
  const worker = new Worker<DocumentDeadlineScoutJobData>(
    DEADLINE_SCOUT_QUEUE_NAME,
    async ({ data }) => {
      const { runDocumentDeadlineScout } =
        await import("@/api/lib/scouts/document-deadlines");
      await runDocumentDeadlineScout(data);
    },
    {
      connection: createBullMqConnection(),
      concurrency: DEADLINE_SCOUT_WORKER_CONCURRENCY,
    },
  );

  worker.on("failed", (job, error) => {
    captureError(error, {
      scout: DEADLINE_SCOUT_JOB_NAME,
      sourceRunId: job?.data.sourceRunId ?? "",
    });
    logger.error("scout.document_deadlines.failed", {
      "error.type": errorTag(error),
      "source.run.id": job?.data.sourceRunId ?? "",
    });
  });
  worker.on(
    "error",
    createQueueWorkerErrorLogger("scout.document_deadlines.worker_error"),
  );

  logger.info("scout.document_deadlines.worker_started", {
    concurrency: String(DEADLINE_SCOUT_WORKER_CONCURRENCY),
  });

  return {
    close: async (): Promise<void> => {
      await worker.close();
    },
  };
};
