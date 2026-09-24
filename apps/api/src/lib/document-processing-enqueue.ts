import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { createLazyBullMqQueue } from "@/api/lib/bullmq-queue";
import { requeueDeterministicJob } from "@/api/lib/bullmq-requeue";
import type { RequeueableQueue } from "@/api/lib/bullmq-requeue";

export const DOCUMENT_PROCESSING_QUEUE_NAME = "document-processing";
export const DOCUMENT_PROCESSING_OCR_JOB_NAME = "ocr";

// Durable run state owns retry classification, backoff, and the attempt cap.
// BullMQ must deliver each enqueue once so it cannot bypass that policy.
const DEFAULT_JOB_ATTEMPTS = 1;
const QUEUE_OPERATION_TIMEOUT_MS = 2000;
export const DEADLINE_SCOUT_QUEUE_NAME = "document-deadline-scouts";
export const DEADLINE_SCOUT_JOB_NAME = "scan-document-deadlines";
const DEADLINE_SCOUT_JOB_ATTEMPTS = 5;

export type DocumentProcessingJobData = {
  runId: SafeId<"documentProcessingRun">;
};

export type DocumentDeadlineScoutJobData = {
  sourceRunId: SafeId<"documentProcessingRun">;
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

const getDeadlineScoutQueue =
  createLazyBullMqQueue<DocumentDeadlineScoutJobData>({
    name: DEADLINE_SCOUT_QUEUE_NAME,
    connectionOptions: {
      connectionTimeout: QUEUE_OPERATION_TIMEOUT_MS,
      enableOfflineQueue: false,
    },
    defaultJobOptions: {
      attempts: DEADLINE_SCOUT_JOB_ATTEMPTS,
      backoff: { type: "exponential", delay: 30_000 },
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
  await requeueDeterministicJob({
    data: { runId },
    jobId: createBullMqJobId(DOCUMENT_PROCESSING_QUEUE_NAME, runId),
    name: DOCUMENT_PROCESSING_OCR_JOB_NAME,
    queue: getQueue(),
  });
};

// PostgreSQL is authoritative: a completed job whose run is still pending may
// have finished just before the worker could persist success, so it is
// replayed rather than read as proof the scan happened.
export const enqueueDocumentDeadlineScoutJob = async ({
  scoutQueue,
  job,
}: {
  scoutQueue: RequeueableQueue<DocumentDeadlineScoutJobData>;
  job: DocumentDeadlineScoutJobData;
}): Promise<void> => {
  await requeueDeterministicJob({
    data: job,
    jobId: createBullMqJobId(DEADLINE_SCOUT_QUEUE_NAME, job.sourceRunId),
    name: DEADLINE_SCOUT_JOB_NAME,
    queue: scoutQueue,
  });
};

/** Enqueue one deterministic scout job; duplicate delivery converges by run ID. */
export const enqueueDocumentDeadlineScout = async (
  job: DocumentDeadlineScoutJobData,
): Promise<void> => {
  await enqueueDocumentDeadlineScoutJob({
    scoutQueue: getDeadlineScoutQueue(),
    job,
  });
};
