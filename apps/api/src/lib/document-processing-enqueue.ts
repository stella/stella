import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { createLazyBullMqQueue } from "@/api/lib/bullmq-queue";

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
  entityId: SafeId<"entity">;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  requestedBy: SafeId<"user"> | null;
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

type ExistingDocumentDeadlineScoutJob = {
  getState: () => Promise<string>;
  retry: () => Promise<unknown>;
};

type DocumentDeadlineScoutQueue = {
  add: (
    name: string,
    data: DocumentDeadlineScoutJobData,
    options: { jobId: string },
  ) => Promise<unknown>;
  getJob: (
    jobId: string,
  ) => Promise<ExistingDocumentDeadlineScoutJob | null | undefined>;
};

export const enqueueDocumentDeadlineScoutJob = async ({
  scoutQueue,
  job,
}: {
  scoutQueue: DocumentDeadlineScoutQueue;
  job: DocumentDeadlineScoutJobData;
}): Promise<void> => {
  const jobId = createBullMqJobId(DEADLINE_SCOUT_QUEUE_NAME, job.sourceRunId);
  const existing = await scoutQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "failed") {
      await existing.retry();
    }
    return;
  }
  await scoutQueue.add(DEADLINE_SCOUT_JOB_NAME, job, { jobId });
};

/**
 * Persist one deterministic scout job before the source processing run becomes
 * terminal. Replaying completion converges on the source run's existing job.
 */
export const enqueueDocumentDeadlineScout = async (
  job: DocumentDeadlineScoutJobData,
): Promise<void> => {
  await enqueueDocumentDeadlineScoutJob({
    scoutQueue: getDeadlineScoutQueue(),
    job,
  });
};
