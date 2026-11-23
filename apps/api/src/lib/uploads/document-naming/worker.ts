import { Result } from "better-result";

import { BullMqWorker } from "@/api/lib/bullmq-queue";
import type { BullMqWorkerContext } from "@/api/lib/bullmq-queue";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { createQueueWorkerErrorLogger } from "@/api/lib/queue-worker-error-log";
import { createBullMqConnection } from "@/api/lib/redis-client";
import {
  DOCUMENT_NAMING_QUEUE_NAME,
  type DocumentNamingJobData,
} from "@/api/lib/uploads/document-naming/queue";

const DOCUMENT_NAMING_WORKER_CONCURRENCY = 1;
const JOB_FAILED_SINK = failureSink({
  event: "document_naming.failed",
  expected: [],
});

export const initDocumentNamingWorker = ({ db }: BullMqWorkerContext) => {
  const worker = new BullMqWorker<DocumentNamingJobData>(
    DOCUMENT_NAMING_QUEUE_NAME,
    async ({ data }) => {
      const { runDocumentNaming } =
        await import("@/api/lib/uploads/document-naming/document-naming");
      const outcome = await runDocumentNaming({ db, sourceRunId: data.runId });
      if (Result.isError(outcome)) {
        // BullMQ retries a job only when its processor throws.
        throw outcome.error;
      }
    },
    {
      connection: createBullMqConnection({
        storeClass: "durable-coordination",
      }),
      concurrency: DOCUMENT_NAMING_WORKER_CONCURRENCY,
    },
  );
  worker.on("failed", (job, error) => {
    observeFailure(error, {
      sink: JOB_FAILED_SINK,
      ctx: job === undefined ? {} : { runId: job.data.runId },
    });
  });
  worker.on(
    "error",
    createQueueWorkerErrorLogger("document_naming.worker_error"),
  );
  return {
    queues: [DOCUMENT_NAMING_QUEUE_NAME] as const,
    close: async (): Promise<void> => {
      await worker.close();
    },
  };
};
