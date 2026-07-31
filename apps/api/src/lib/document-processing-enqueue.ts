import { Queue } from "bullmq";

import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { createBullMqConnection } from "@/api/lib/redis-client";

export const DOCUMENT_PROCESSING_QUEUE_NAME = "document-processing";
export const DOCUMENT_PROCESSING_OCR_JOB_NAME = "ocr";

// Durable run state owns retry classification, backoff, and the attempt cap.
// BullMQ must deliver each enqueue once so it cannot bypass that policy.
const DEFAULT_JOB_ATTEMPTS = 1;
const QUEUE_OPERATION_TIMEOUT_MS = 2000;

export type DocumentProcessingJobData = {
  runId: SafeId<"documentProcessingRun">;
};

let queue: Queue<DocumentProcessingJobData> | null = null;
let queueConnection: ReturnType<typeof createBullMqConnection> | null = null;

const getQueueConnection = () => {
  queueConnection ??= createBullMqConnection({
    connectionTimeout: QUEUE_OPERATION_TIMEOUT_MS,
    enableOfflineQueue: false,
  });
  return queueConnection;
};

const getQueue = (): Queue<DocumentProcessingJobData> => {
  queue ??= new Queue<DocumentProcessingJobData>(
    DOCUMENT_PROCESSING_QUEUE_NAME,
    {
      connection: getQueueConnection(),
      defaultJobOptions: {
        attempts: DEFAULT_JOB_ATTEMPTS,
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    },
  );
  return queue;
};

export const enqueueDocumentProcessingRun = async (
  runId: SafeId<"documentProcessingRun">,
): Promise<void> => {
  const jobId = createBullMqJobId(DOCUMENT_PROCESSING_QUEUE_NAME, runId);
  const existing = await getQueue().getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "failed") {
      await existing.retry();
      return;
    }
    if (state !== "completed") {
      return;
    }
    await existing.remove();
  }

  await getQueue().add(DOCUMENT_PROCESSING_OCR_JOB_NAME, { runId }, { jobId });
};
