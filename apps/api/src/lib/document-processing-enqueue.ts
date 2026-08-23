import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { createLazyBullMqQueue } from "@/api/lib/bullmq-queue";

export const DOCUMENT_PROCESSING_QUEUE_NAME = "document-processing";
export const DOCUMENT_PROCESSING_OCR_JOB_NAME = "ocr";

// Durable run state owns retry classification, backoff, and the attempt cap.
// BullMQ must deliver each enqueue once so it cannot bypass that policy.
const DEFAULT_JOB_ATTEMPTS = 1;
const QUEUE_OPERATION_TIMEOUT_MS = 2000;

export type DocumentProcessingJobData = {
  runId: SafeId<"documentProcessingRun">;
};

const getQueue = createLazyBullMqQueue<DocumentProcessingJobData>({
  name: DOCUMENT_PROCESSING_QUEUE_NAME,
  connectionOptions: {
    connectionTimeout: QUEUE_OPERATION_TIMEOUT_MS,
    enableOfflineQueue: false,
  },
  defaultJobOptions: {
    attempts: DEFAULT_JOB_ATTEMPTS,
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

/**
 * Jobs currently visible to the queue in any not-yet-finished state. The
 * idle-exit check in the worker entry treats zero as "nothing left to do".
 */
export const countPendingDocumentProcessingJobs = async (): Promise<number> => {
  const counts = await getQueue().getJobCounts(
    "active",
    "delayed",
    "prioritized",
    "waiting",
    "waiting-children",
  );
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
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
