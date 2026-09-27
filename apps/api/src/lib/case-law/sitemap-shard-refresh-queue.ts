import { Worker } from "bullmq";

import { captureError, detached } from "@/api/lib/analytics/capture";
import { createLazyBullMqQueue } from "@/api/lib/bullmq-queue";
import type { BullMqWorkerContext } from "@/api/lib/bullmq-queue";
import { errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { createQueueWorkerErrorLogger } from "@/api/lib/queue-worker-error-log";
import { createBullMqConnection } from "@/api/lib/redis-client";

const QUEUE_NAME = "case-law-sitemap-shards";
const REFRESH_JOB_NAME = "refresh-case-law-sitemap-shards";
const REFRESH_SCHEDULER_ID = "case-law-sitemap-shards-refresh";

/**
 * How often the sitemap snapshot is recounted. Crawlers revisit a sitemap
 * index on the order of hours, and the shard read counts live rows, so a
 * snapshot this old only delays when a new month is listed.
 */
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

const getQueue = createLazyBullMqQueue({
  name: QUEUE_NAME,
  defaultJobOptions: {
    removeOnComplete: 10,
    removeOnFail: 50,
  },
});

/**
 * Keeps the public case-law sitemap snapshot current. The scheduler is keyed,
 * so every API task upserting it on start leaves one schedule, and BullMQ runs
 * its first refresh at once, which is what fills the snapshot after a deploy.
 */
export const initCaseLawSitemapShardWorker = ({ db }: BullMqWorkerContext) => {
  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      const { refreshCaseLawSitemapShards } =
        await import("@/api/lib/case-law/sitemap-shard-refresh");
      const outcome = await refreshCaseLawSitemapShards(db);
      logger.info("case_law.sitemap.shard_refresh_finished", {
        outcome: outcome.type,
        shards: outcome.type === "refreshed" ? outcome.shards : 0,
      });
    },
    { connection: createBullMqConnection(), concurrency: 1 },
  );

  worker.on("failed", (_job, error) => {
    captureError(error, { job: REFRESH_JOB_NAME });
    logger.error("case_law.sitemap.shard_refresh_failed", {
      "error.type": errorTag(error),
    });
  });
  worker.on(
    "error",
    createQueueWorkerErrorLogger("case_law.sitemap.shard_refresh_worker_error"),
  );

  detached(
    getQueue().upsertJobScheduler(
      REFRESH_SCHEDULER_ID,
      { every: REFRESH_INTERVAL_MS },
      { name: REFRESH_JOB_NAME },
    ),
    "case-law-sitemap.schedule",
  );

  return {
    queues: [QUEUE_NAME] as const,
    close: async (): Promise<void> => {
      await worker.close();
    },
  };
};
