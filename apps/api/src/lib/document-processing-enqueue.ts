import { Worker } from "bullmq";

import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { createLazyBullMqQueue } from "@/api/lib/bullmq-queue";
import { connectionErrorFields, errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { createBullMqConnection } from "@/api/lib/redis-client";

export const DOCUMENT_PROCESSING_QUEUE_NAME = "document-processing";
export const DOCUMENT_PROCESSING_OCR_JOB_NAME = "ocr";

// Durable run state owns retry classification, backoff, and the attempt cap.
// BullMQ must deliver each enqueue once so it cannot bypass that policy.
const DEFAULT_JOB_ATTEMPTS = 1;
const QUEUE_OPERATION_TIMEOUT_MS = 2000;
const DEADLINE_SCOUT_QUEUE_NAME = "document-deadline-scouts";
const DEADLINE_SCOUT_JOB_NAME = "scan-document-deadlines";
const DEADLINE_SCOUT_JOB_ATTEMPTS = 5;
const DEADLINE_SCOUT_WORKER_CONCURRENCY = 1;

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
      "entity.id": job?.data.entityId ?? "",
      "error.type": errorTag(error),
      "source.run.id": job?.data.sourceRunId ?? "",
      "workspace.id": job?.data.workspaceId ?? "",
    });
  });
  worker.on("error", (error) => {
    logger.error(
      "scout.document_deadlines.worker_error",
      connectionErrorFields(error),
    );
  });

  logger.info("scout.document_deadlines.worker_started", {
    concurrency: String(DEADLINE_SCOUT_WORKER_CONCURRENCY),
  });

  return {
    close: async (): Promise<void> => {
      await worker.close();
    },
  };
};
