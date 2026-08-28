import { Worker } from "bullmq";
import { eq, or } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { styleSets } from "@/api/db/schema";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { createLazyBullMqQueue } from "@/api/lib/bullmq-queue";
import { errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { createQueueWorkerErrorLogger } from "@/api/lib/queue-worker-error-log";
import { createBullMqConnection } from "@/api/lib/redis-client";
import { getS3 } from "@/api/lib/s3";
import { STYLE_SET_DOWNLOAD_TTL_SECONDS } from "@/api/lib/style-sets";

const QUEUE_NAME = "style-set-package-cleanup";
const CLEANUP_JOB_NAME = "delete-style-set-package";
const DEFAULT_JOB_ATTEMPTS = 3;

/**
 * How long a package written ahead of its row may stay unclaimed. The write
 * and the row that names it cannot commit together, so the cleanup job is
 * enqueued first and this delay is the window the request has to make the row
 * reference the key. It only has to outlast one upload request.
 */
export const STYLE_SET_PACKAGE_ABANDON_DELAY_MS = 15 * 60 * 1000;

type StyleSetPackageCleanupJobData = {
  s3Key: string;
  styleSetId: string;
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

const getQueue = createLazyBullMqQueue<StyleSetPackageCleanupJobData>({
  name: QUEUE_NAME,
  defaultJobOptions: {
    attempts: DEFAULT_JOB_ATTEMPTS,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

export const enqueueStyleSetPackageCleanup = async ({
  s3Key,
  styleSetId,
  delayMs = STYLE_SET_DOWNLOAD_TTL_SECONDS * 1000,
}: EnqueueStyleSetPackageCleanupOptions): Promise<void> =>
  await enqueueStyleSetPackageCleanupJob({
    cleanupQueue: getQueue(),
    delayMs,
    s3Key,
    styleSetId,
  });

export const enqueueStyleSetPackageCleanupJob = async ({
  cleanupQueue,
  delayMs,
  s3Key,
  styleSetId,
}: {
  cleanupQueue: StyleSetPackageCleanupQueue;
  delayMs: number;
  s3Key: string;
  styleSetId: string;
}): Promise<void> => {
  // The job id is derived from the key, so a claim for a key this queue has
  // already handled collides with the retained record of that run. Both
  // terminal states have to be reclaimed, not just `failed`: a claim placed
  // ahead of the write completes as a no-op while the style set is still live,
  // and `removeOnComplete` keeps that record, so a later replacement of the
  // same key would `add()` a duplicate id, BullMQ would ignore it, and the
  // superseded object would be left with no runnable cleanup. A job still
  // waiting, delayed, or active needs no re-add: it is the claim.
  const jobId = createBullMqJobId(CLEANUP_JOB_NAME, s3Key);
  const existingJob = await cleanupQueue.getJob(jobId);
  if (existingJob) {
    const state = await existingJob.getState();
    if (state !== "completed" && state !== "failed") {
      return;
    }
    await existingJob.remove();
  }

  await cleanupQueue.add(
    CLEANUP_JOB_NAME,
    { s3Key, styleSetId },
    { delay: Math.max(0, delayMs), jobId },
  );
};

export const deleteQueuedStyleSetPackages = async (
  styleSetId: string,
): Promise<void> => {
  // BullMQ 6 dropped the separate `paused` state: a paused queue's jobs are
  // reported as `waiting`, which this list already covers.
  const jobs = await getQueue().getJobs([
    "active",
    "delayed",
    "failed",
    "prioritized",
    "waiting",
    "waiting-children",
  ]);
  const s3Keys = jobs
    .filter((job) => job.data.styleSetId === styleSetId)
    .map((job) => job.data.s3Key);
  await Promise.all(s3Keys.map(async (s3Key) => await getS3().delete(s3Key)));
};

/**
 * Delete a package object unless a style set still names it.
 *
 * The check is what makes a cleanup job safe to enqueue *before* the object
 * exists: an abandoned write is deleted, while a write whose row committed is
 * left alone, and no ordering between the two decides the outcome. It also
 * keeps a stale job from deleting a package the row still points at when the
 * outbox column could not be cleared.
 */
export const deleteUnreferencedStyleSetPackage = async (
  s3Key: string,
): Promise<void> => {
  const [referencing] = await rootDb
    .select({ id: styleSets.id })
    .from(styleSets)
    .where(or(eq(styleSets.s3Key, s3Key), eq(styleSets.cleanupS3Key, s3Key)))
    .limit(1);
  if (referencing) {
    logger.debug("style_set_package_cleanup.still_referenced", {
      styleSetId: referencing.id,
    });
    return;
  }
  await getS3().delete(s3Key);
};

export const initStyleSetPackageCleanupWorker = () => {
  const workerConnection = createBullMqConnection();
  const worker = new Worker<StyleSetPackageCleanupJobData>(
    QUEUE_NAME,
    async (job) => {
      await deleteUnreferencedStyleSetPackage(job.data.s3Key);
    },
    { connection: workerConnection },
  );

  worker.on("failed", (job, error) => {
    logger.error("style_set_package_cleanup.failed", {
      "error.type": errorTag(error),
      "job.available": Boolean(job),
    });
  });
  worker.on(
    "error",
    createQueueWorkerErrorLogger("style_set_package_cleanup.worker_error"),
  );

  return worker;
};
