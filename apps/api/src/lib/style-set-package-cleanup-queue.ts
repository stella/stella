import { Queue, Worker } from "bullmq";

import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { connectionErrorFields, errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { createBullMqConnection } from "@/api/lib/redis-client";
import { getS3 } from "@/api/lib/s3";
import { STYLE_SET_DOWNLOAD_TTL_SECONDS } from "@/api/lib/style-sets";

const QUEUE_NAME = "style-set-package-cleanup";
const CLEANUP_JOB_NAME = "delete-style-set-package";
const DEFAULT_JOB_ATTEMPTS = 3;

type StyleSetPackageCleanupJobData = {
  s3Key: string;
};

type EnqueueStyleSetPackageCleanupOptions = StyleSetPackageCleanupJobData & {
  delayMs?: number;
};

type StyleSetPackageCleanupJob = {
  getState: () => Promise<string>;
  remove: () => Promise<void>;
};

type StyleSetPackageCleanupQueue = {
  add: (
    name: string,
    data: StyleSetPackageCleanupJobData,
    options: { delay: number; jobId: string },
  ) => Promise<unknown>;
  getJob: (jobId: string) => Promise<StyleSetPackageCleanupJob | undefined>;
};

let queue: Queue<StyleSetPackageCleanupJobData> | null = null;
let queueConnection: ReturnType<typeof createBullMqConnection> | null = null;

const getQueueConnection = () => {
  queueConnection ??= createBullMqConnection();
  return queueConnection;
};

const getQueue = (): Queue<StyleSetPackageCleanupJobData> => {
  queue ??= new Queue<StyleSetPackageCleanupJobData>(QUEUE_NAME, {
    connection: getQueueConnection(),
    defaultJobOptions: {
      attempts: DEFAULT_JOB_ATTEMPTS,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });
  return queue;
};

export const enqueueStyleSetPackageCleanup = async ({
  s3Key,
  delayMs = STYLE_SET_DOWNLOAD_TTL_SECONDS * 1000,
}: EnqueueStyleSetPackageCleanupOptions): Promise<void> =>
  await enqueueStyleSetPackageCleanupJob({
    cleanupQueue: getQueue(),
    delayMs,
    s3Key,
  });

export const enqueueStyleSetPackageCleanupJob = async ({
  cleanupQueue,
  delayMs,
  s3Key,
}: {
  cleanupQueue: StyleSetPackageCleanupQueue;
  delayMs: number;
  s3Key: string;
}): Promise<void> => {
  const jobId = createBullMqJobId(CLEANUP_JOB_NAME, s3Key);
  const existingJob = await cleanupQueue.getJob(jobId);
  if (existingJob && (await existingJob.getState()) === "failed") {
    await existingJob.remove();
  }

  await cleanupQueue.add(
    CLEANUP_JOB_NAME,
    { s3Key },
    { delay: Math.max(0, delayMs), jobId },
  );
};

export const initStyleSetPackageCleanupWorker = () => {
  const workerConnection = createBullMqConnection();
  const worker = new Worker<StyleSetPackageCleanupJobData>(
    QUEUE_NAME,
    async (job) => {
      await getS3().delete(job.data.s3Key);
    },
    { connection: workerConnection },
  );

  worker.on("failed", (job, error) => {
    logger.error("style_set_package_cleanup.failed", {
      "error.type": errorTag(error),
      "job.available": Boolean(job),
    });
  });
  worker.on("error", (error) => {
    logger.error(
      "style_set_package_cleanup.worker_error",
      connectionErrorFields(error),
    );
  });

  return worker;
};
