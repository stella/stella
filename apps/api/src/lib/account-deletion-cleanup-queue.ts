import { Result } from "better-result";
import { type Queue, Worker } from "bullmq";

import {
  claimNextAccountDeletionEffectChunk,
  completeAccountDeletionEffectChunk,
  ensureAccountDeletionEffectChunks,
  failAccountDeletionEffectChunk,
  listRecoverableAccountDeletionEffectRequestIds,
} from "@/api/lib/account-deletion-effect-store";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { createLazyBullMqQueue } from "@/api/lib/bullmq-queue";
import { detached } from "@/api/lib/detached";
import { errorSystemFields, errorTag } from "@/api/lib/errors/utils";
import { deleteS3Keys } from "@/api/lib/files/utils";
import { logger } from "@/api/lib/observability/logger";
import { createQueueWorkerErrorLogger } from "@/api/lib/queue-worker-error-log";
import { createBullMqConnection } from "@/api/lib/redis-client";

const QUEUE_NAME = "account-deletion-cleanup";
const STORAGE_CLEANUP_JOB_NAME = "storage-cleanup";
const DEFAULT_JOB_ATTEMPTS = 5;
const WORKER_CONCURRENCY = 2;
const RECONCILE_INTERVAL_MS = 60_000;
const MAX_CHUNKS_PER_JOB = 10;

type AccountDeletionCleanupJobData = {
  requestId: SafeId<"accountDeletionRequest">;
};

type AccountDeletionCleanupQueue = Pick<
  Queue<AccountDeletionCleanupJobData>,
  "add" | "getJob"
>;

type AccountDeletionCleanupRequestDeps = {
  claimChunk: typeof claimNextAccountDeletionEffectChunk;
  completeChunk: typeof completeAccountDeletionEffectChunk;
  deleteS3Keys: typeof deleteS3Keys;
  ensureChunks: typeof ensureAccountDeletionEffectChunks;
  failChunk: typeof failAccountDeletionEffectChunk;
};

const defaultCleanupRequestDeps: AccountDeletionCleanupRequestDeps = {
  claimChunk: claimNextAccountDeletionEffectChunk,
  completeChunk: completeAccountDeletionEffectChunk,
  deleteS3Keys,
  ensureChunks: ensureAccountDeletionEffectChunks,
  failChunk: failAccountDeletionEffectChunk,
};

const getQueue = createLazyBullMqQueue<AccountDeletionCleanupJobData>({
  name: QUEUE_NAME,
  defaultJobOptions: {
    attempts: DEFAULT_JOB_ATTEMPTS,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

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
    if (state === "failed" || state === "completed") {
      await existingJob.remove();
    } else {
      return;
    }
  }

  await cleanupQueue.add(STORAGE_CLEANUP_JOB_NAME, { requestId }, { jobId });
};

type DrainAccountDeletionEffectsParams = {
  deps: AccountDeletionCleanupRequestDeps;
  remaining: number;
  requestId: SafeId<"accountDeletionRequest">;
};

const drainAccountDeletionEffects = async ({
  deps,
  remaining,
  requestId,
}: DrainAccountDeletionEffectsParams): Promise<void> => {
  if (remaining === 0) {
    return;
  }
  const claim = await deps.claimChunk(requestId);
  if (!claim) {
    return;
  }
  const deleteResult = await deps.deleteS3Keys(claim.s3Keys);
  if (Result.isError(deleteResult)) {
    await deps.failChunk(claim, deleteResult.error);
    throw deleteResult.error;
  }
  await deps.completeChunk(claim);
  await drainAccountDeletionEffects({
    deps,
    remaining: remaining - 1,
    requestId,
  });
};

export const processAccountDeletionCleanupRequest = async (
  requestId: SafeId<"accountDeletionRequest">,
  deps: AccountDeletionCleanupRequestDeps = defaultCleanupRequestDeps,
): Promise<void> => {
  await deps.ensureChunks(requestId);
  await drainAccountDeletionEffects({
    deps,
    remaining: MAX_CHUNKS_PER_JOB,
    requestId,
  });
};

export const enqueuePendingAccountDeletionCleanupRequests =
  async (): Promise<number> => {
    const requestIds = await listRecoverableAccountDeletionEffectRequestIds();

    await Promise.all(
      requestIds.map(async (id) => await enqueueAccountDeletionCleanup(id)),
    );
    return requestIds.length;
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

  worker.on(
    "error",
    createQueueWorkerErrorLogger("account_deletion_cleanup.worker_error"),
  );

  const reconcile = () => {
    detached(
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
          logger.error(
            "account_deletion_cleanup.reconcile_failed",
            errorSystemFields(error),
          );
        }
      })(),
      "account-deletion-cleanup.reconcile",
    );
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
