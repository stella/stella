import { Result } from "better-result";
import { Queue, Worker } from "bullmq";
import { and, asc, eq, inArray, lt, or, sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { entityDeletionCleanupRequests } from "@/api/db/schema";
import { deleteS3Keys } from "@/api/handlers/files/utils";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { detached } from "@/api/lib/detached";
import { connectionErrorFields, errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { createBullMqConnection } from "@/api/lib/redis-client";

const QUEUE_NAME = "entity-deletion-cleanup";
const STORAGE_CLEANUP_JOB_NAME = "storage-cleanup";
const DEFAULT_JOB_ATTEMPTS = 5;
const WORKER_CONCURRENCY = 2;
const RECONCILE_INTERVAL_MS = 60_000;
const STALE_PROCESSING_MS = 15 * 60_000;
const RECONCILE_BATCH_SIZE = 50;
const MAX_RECONCILED_ATTEMPTS = 20;

type EntityDeletionCleanupJobData = {
  requestId: SafeId<"entityDeletionCleanupRequest">;
};

type EntityDeletionCleanupQueue = Pick<
  Queue<EntityDeletionCleanupJobData>,
  "add" | "getJob"
>;

type EntityDeletionCleanupRequestDeps = {
  deleteS3Keys: typeof deleteS3Keys;
  logger: Pick<typeof logger, "warn">;
  rootDb: Pick<typeof rootDb, "select" | "update">;
};

const defaultCleanupRequestDeps: EntityDeletionCleanupRequestDeps = {
  deleteS3Keys,
  logger,
  rootDb,
};

let queue: Queue<EntityDeletionCleanupJobData> | null = null;
let queueConnection: ReturnType<typeof createBullMqConnection> | null = null;

const getQueueConnection = () => {
  queueConnection ??= createBullMqConnection();
  return queueConnection;
};

const getQueue = (): Queue<EntityDeletionCleanupJobData> => {
  queue ??= new Queue<EntityDeletionCleanupJobData>(QUEUE_NAME, {
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

export const enqueueEntityDeletionCleanup = async (
  requestId: SafeId<"entityDeletionCleanupRequest">,
): Promise<void> => {
  await enqueueEntityDeletionCleanupJob({
    cleanupQueue: getQueue(),
    requestId,
  });
};

export const enqueueEntityDeletionCleanupJob = async ({
  cleanupQueue,
  requestId,
}: {
  cleanupQueue: EntityDeletionCleanupQueue;
  requestId: SafeId<"entityDeletionCleanupRequest">;
}): Promise<void> => {
  const jobId = createBullMqJobId(requestId, STORAGE_CLEANUP_JOB_NAME);
  const existingJob = await cleanupQueue.getJob(jobId);
  if (existingJob) {
    const state = await existingJob.getState();
    if (state === "failed") {
      await existingJob.remove();
    }
  }

  await cleanupQueue.add(STORAGE_CLEANUP_JOB_NAME, { requestId }, { jobId });
};

export const processEntityDeletionCleanupRequest = async (
  requestId: SafeId<"entityDeletionCleanupRequest">,
  deps: EntityDeletionCleanupRequestDeps = defaultCleanupRequestDeps,
): Promise<void> => {
  const request = await deps.rootDb
    .select({
      id: entityDeletionCleanupRequests.id,
      s3Keys: entityDeletionCleanupRequests.s3Keys,
      status: entityDeletionCleanupRequests.status,
    })
    .from(entityDeletionCleanupRequests)
    .where(eq(entityDeletionCleanupRequests.id, requestId))
    .limit(1)
    .then((rows) => rows.at(0));

  if (!request) {
    deps.logger.warn("entity_deletion_cleanup.request_missing", { requestId });
    return;
  }
  if (request.status === "completed") {
    return;
  }

  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);
  const claimed = await deps.rootDb
    .update(entityDeletionCleanupRequests)
    .set({
      attemptCount: sql`${entityDeletionCleanupRequests.attemptCount} + 1`,
      errorMessage: null,
      status: "processing",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(entityDeletionCleanupRequests.id, requestId),
        or(
          inArray(entityDeletionCleanupRequests.status, ["pending", "failed"]),
          and(
            eq(entityDeletionCleanupRequests.status, "processing"),
            lt(entityDeletionCleanupRequests.updatedAt, staleBefore),
          ),
        ),
      ),
    )
    .returning({
      attemptCount: entityDeletionCleanupRequests.attemptCount,
      s3Keys: entityDeletionCleanupRequests.s3Keys,
    });
  const claim = claimed.at(0);
  if (!claim) {
    return;
  }

  const deleteResult = await deps.deleteS3Keys(claim.s3Keys);
  if (Result.isError(deleteResult)) {
    await deps.rootDb
      .update(entityDeletionCleanupRequests)
      .set({
        errorMessage: deleteResult.error.message,
        status: "failed",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(entityDeletionCleanupRequests.id, requestId),
          eq(entityDeletionCleanupRequests.status, "processing"),
          eq(entityDeletionCleanupRequests.attemptCount, claim.attemptCount),
        ),
      );
    throw deleteResult.error;
  }

  await deps.rootDb
    .update(entityDeletionCleanupRequests)
    .set({
      completedAt: new Date(),
      errorMessage: null,
      status: "completed",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(entityDeletionCleanupRequests.id, requestId),
        eq(entityDeletionCleanupRequests.status, "processing"),
        eq(entityDeletionCleanupRequests.attemptCount, claim.attemptCount),
      ),
    );
};

export const enqueuePendingEntityDeletionCleanupRequests =
  async (): Promise<number> => {
    const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);
    const rows = await rootDb
      .select({ id: entityDeletionCleanupRequests.id })
      .from(entityDeletionCleanupRequests)
      .where(
        and(
          lt(
            entityDeletionCleanupRequests.attemptCount,
            MAX_RECONCILED_ATTEMPTS,
          ),
          or(
            inArray(entityDeletionCleanupRequests.status, [
              "pending",
              "failed",
            ]),
            and(
              eq(entityDeletionCleanupRequests.status, "processing"),
              lt(entityDeletionCleanupRequests.updatedAt, staleBefore),
            ),
          ),
        ),
      )
      .orderBy(asc(entityDeletionCleanupRequests.createdAt))
      .limit(RECONCILE_BATCH_SIZE);

    await Promise.all(
      rows.map(async (row) => await enqueueEntityDeletionCleanup(row.id)),
    );
    return rows.length;
  };

export const initEntityDeletionCleanupWorker = () => {
  const worker = new Worker<EntityDeletionCleanupJobData>(
    QUEUE_NAME,
    async (job) => {
      await processEntityDeletionCleanupRequest(job.data.requestId);
    },
    {
      connection: createBullMqConnection(),
      concurrency: WORKER_CONCURRENCY,
    },
  );

  worker.on("failed", (job, error) => {
    captureError(error, { requestId: job?.data.requestId ?? "" });
    logger.error("entity_deletion_cleanup.failed", {
      "error.type": errorTag(error),
      requestId: job?.data.requestId ?? "",
    });
  });
  worker.on("error", (error) => {
    logger.error(
      "entity_deletion_cleanup.worker_error",
      connectionErrorFields(error),
    );
  });

  const reconcile = () => {
    detached(
      (async () => {
        try {
          await enqueuePendingEntityDeletionCleanupRequests();
        } catch (error) {
          captureError(error);
          logger.error("entity_deletion_cleanup.reconcile_failed", {
            "error.type": errorTag(error),
          });
        }
      })(),
      "entity-deletion-cleanup.reconcile",
    );
  };
  reconcile();
  const reconcileInterval = setInterval(reconcile, RECONCILE_INTERVAL_MS);

  logger.info("entity_deletion_cleanup.worker_started", {
    concurrency: String(WORKER_CONCURRENCY),
  });

  return {
    close: async () => {
      clearInterval(reconcileInterval);
      await worker.close();
    },
  };
};
