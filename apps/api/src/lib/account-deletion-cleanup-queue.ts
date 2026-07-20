import { Result } from "better-result";
import { Queue, Worker } from "bullmq";
import { and, asc, eq, inArray, lt, or, sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { accountDeletionRequests } from "@/api/db/schema";
import { deleteS3Keys } from "@/api/handlers/files/utils";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { connectionErrorFields, errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { createBullMqConnection } from "@/api/lib/redis-client";

const QUEUE_NAME = "account-deletion-cleanup";
const STORAGE_CLEANUP_JOB_NAME = "storage-cleanup";
const DEFAULT_JOB_ATTEMPTS = 5;
const WORKER_CONCURRENCY = 2;
const RECONCILE_INTERVAL_MS = 60_000;
const STALE_PROCESSING_MS = 15 * 60_000;
const RECONCILE_BATCH_SIZE = 50;
const MAX_RECONCILED_ATTEMPTS = 20;

type AccountDeletionCleanupJobData = {
  requestId: SafeId<"accountDeletionRequest">;
};

type AccountDeletionCleanupQueue = Pick<
  Queue<AccountDeletionCleanupJobData>,
  "add" | "getJob"
>;

type AccountDeletionCleanupRequestDeps = {
  deleteS3Keys: typeof deleteS3Keys;
  logger: Pick<typeof logger, "warn">;
  rootDb: Pick<typeof rootDb, "select" | "update">;
};

const defaultCleanupRequestDeps: AccountDeletionCleanupRequestDeps = {
  deleteS3Keys,
  logger,
  rootDb,
};

let queue: Queue<AccountDeletionCleanupJobData> | null = null;
let queueConnection: ReturnType<typeof createBullMqConnection> | null = null;

const getQueueConnection = () => {
  queueConnection ??= createBullMqConnection();
  return queueConnection;
};

const getQueue = (): Queue<AccountDeletionCleanupJobData> => {
  queue ??= new Queue<AccountDeletionCleanupJobData>(QUEUE_NAME, {
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

export const enqueueAccountDeletionCleanup = async (
  requestId: SafeId<"accountDeletionRequest">,
): Promise<void> => {
  await enqueueAccountDeletionCleanupJob({
    cleanupQueue: getQueue(),
    requestId,
  });
};

export const enqueueAccountDeletionCleanupJob = async ({
  cleanupQueue,
  requestId,
}: {
  cleanupQueue: AccountDeletionCleanupQueue;
  requestId: SafeId<"accountDeletionRequest">;
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

export const processAccountDeletionCleanupRequest = async (
  requestId: SafeId<"accountDeletionRequest">,
  deps: AccountDeletionCleanupRequestDeps = defaultCleanupRequestDeps,
): Promise<void> => {
  const request = await deps.rootDb
    .select({
      id: accountDeletionRequests.id,
      status: accountDeletionRequests.status,
      storageCleanup: accountDeletionRequests.storageCleanup,
    })
    .from(accountDeletionRequests)
    .where(eq(accountDeletionRequests.id, requestId))
    .limit(1)
    .then((rows) => rows.at(0));

  if (!request) {
    deps.logger.warn("account_deletion_cleanup.request_missing", { requestId });
    return;
  }

  if (request.status === "completed") {
    return;
  }

  const s3Keys = request.storageCleanup.s3Keys;

  await deps.rootDb
    .update(accountDeletionRequests)
    .set({
      attemptCount: sql`${accountDeletionRequests.attemptCount} + 1`,
      errorMessage: null,
      status: "processing",
      updatedAt: new Date(),
    })
    .where(eq(accountDeletionRequests.id, requestId));

  if (s3Keys.length === 0) {
    await markCleanupCompleted(requestId, deps.rootDb);
    return;
  }

  const deleteResult = await deps.deleteS3Keys(s3Keys);
  if (Result.isError(deleteResult)) {
    await deps.rootDb
      .update(accountDeletionRequests)
      .set({
        errorMessage: deleteResult.error.message,
        status: "failed",
        updatedAt: new Date(),
      })
      .where(eq(accountDeletionRequests.id, requestId));

    throw deleteResult.error;
  }

  await markCleanupCompleted(requestId, deps.rootDb);
};

export const enqueuePendingAccountDeletionCleanupRequests =
  async (): Promise<number> => {
    const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);
    const rows = await rootDb
      .select({ id: accountDeletionRequests.id })
      .from(accountDeletionRequests)
      .where(
        and(
          lt(accountDeletionRequests.attemptCount, MAX_RECONCILED_ATTEMPTS),
          or(
            inArray(accountDeletionRequests.status, ["pending", "failed"]),
            and(
              eq(accountDeletionRequests.status, "processing"),
              lt(accountDeletionRequests.updatedAt, staleBefore),
            ),
          ),
        ),
      )
      .orderBy(asc(accountDeletionRequests.createdAt))
      .limit(RECONCILE_BATCH_SIZE);

    await Promise.all(
      rows.map(async (row) => await enqueueAccountDeletionCleanup(row.id)),
    );
    return rows.length;
  };

export const initAccountDeletionCleanupWorker = () => {
  const workerConnection = createBullMqConnection();

  const worker = new Worker<AccountDeletionCleanupJobData>(
    QUEUE_NAME,
    async (job) => {
      await processAccountDeletionCleanupRequest(job.data.requestId);
    },
    {
      connection: workerConnection,
      concurrency: WORKER_CONCURRENCY,
    },
  );

  worker.on("failed", (job, error) => {
    captureError(error, { requestId: job?.data.requestId ?? "" });
    logger.error("account_deletion_cleanup.failed", {
      "error.type": errorTag(error),
      requestId: job?.data.requestId ?? "",
    });
  });

  worker.on("error", (error) => {
    logger.error(
      "account_deletion_cleanup.worker_error",
      connectionErrorFields(error),
    );
  });

  const reconcile = () => {
    (async () => {
      try {
        const count = await enqueuePendingAccountDeletionCleanupRequests();
        if (count === 0) {
          return;
        }

        logger.info("account_deletion_cleanup.reconciled", {
          count: String(count),
        });
      } catch (error) {
        captureError(error);
        logger.error("account_deletion_cleanup.reconcile_failed", {
          "error.type": errorTag(error),
        });
      }
    })();
  };
  reconcile();
  const reconcileInterval = setInterval(reconcile, RECONCILE_INTERVAL_MS);

  logger.info("account_deletion_cleanup.worker_started", {
    concurrency: String(WORKER_CONCURRENCY),
  });

  return {
    close: async () => {
      clearInterval(reconcileInterval);
      await worker.close();
    },
  };
};

const markCleanupCompleted = async (
  requestId: SafeId<"accountDeletionRequest">,
  db: AccountDeletionCleanupRequestDeps["rootDb"] = rootDb,
): Promise<void> => {
  await db
    .update(accountDeletionRequests)
    .set({
      completedAt: new Date(),
      errorMessage: null,
      status: "completed",
      updatedAt: new Date(),
    })
    .where(eq(accountDeletionRequests.id, requestId));
};
