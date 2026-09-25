import { Result } from "better-result";
import { Worker } from "bullmq";

import {
  claimNextAccountDeletionEffectChunk,
  completeAccountDeletionEffectChunk,
  ensureAccountDeletionEffectChunks,
  failAccountDeletionEffectChunk,
  listRecoverableAccountDeletionEffectRequestIds,
} from "@/api/lib/account-deletion-effect-store";
import type {
  AccountDeletionEffectClaim,
  AccountDeletionEffectDb,
} from "@/api/lib/account-deletion-effect-store";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { createLazyBullMqQueue } from "@/api/lib/bullmq-queue";
import type { BullMqWorkerContext } from "@/api/lib/bullmq-queue";
import { requeueDeterministicJob } from "@/api/lib/bullmq-requeue";
import type { RequeueableQueue } from "@/api/lib/bullmq-requeue";
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

type AccountDeletionCleanupRequestDeps = {
  claimChunk: (
    requestId: SafeId<"accountDeletionRequest">,
  ) => Promise<AccountDeletionEffectClaim | null>;
  completeChunk: (claim: AccountDeletionEffectClaim) => Promise<boolean>;
  deleteS3Keys: typeof deleteS3Keys;
  ensureChunks: (
    requestId: SafeId<"accountDeletionRequest">,
  ) => Promise<number>;
  failChunk: (
    claim: AccountDeletionEffectClaim,
    error: Error,
  ) => Promise<boolean>;
};

/** The effect store bound to the caller's connection. */
export const createAccountDeletionCleanupRequestDeps = (
  db: AccountDeletionEffectDb,
): AccountDeletionCleanupRequestDeps => ({
  claimChunk: async (requestId) =>
    await claimNextAccountDeletionEffectChunk(requestId, db),
  completeChunk: async (claim) =>
    await completeAccountDeletionEffectChunk(claim, db),
  deleteS3Keys,
  ensureChunks: async (requestId) =>
    await ensureAccountDeletionEffectChunks(requestId, db),
  failChunk: async (claim, error) =>
    await failAccountDeletionEffectChunk(claim, error, db),
});

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
  cleanupQueue: RequeueableQueue<AccountDeletionCleanupJobData>;
  requestId: SafeId<"accountDeletionRequest">;
}): Promise<void> => {
  await requeueDeterministicJob({
    data: { requestId },
    jobId: createBullMqJobId(requestId, STORAGE_CLEANUP_JOB_NAME),
    name: STORAGE_CLEANUP_JOB_NAME,
    queue: cleanupQueue,
  });
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
  deps: AccountDeletionCleanupRequestDeps,
): Promise<void> => {
  await deps.ensureChunks(requestId);
  await drainAccountDeletionEffects({
    deps,
    remaining: MAX_CHUNKS_PER_JOB,
    requestId,
  });
};

export const enqueuePendingAccountDeletionCleanupRequests = async (
  db: AccountDeletionEffectDb,
): Promise<number> => {
  const requestIds = await listRecoverableAccountDeletionEffectRequestIds(db);

  await Promise.all(
    requestIds.map(async (id) => await enqueueAccountDeletionCleanup(id)),
  );
  return requestIds.length;
};

export const initAccountDeletionCleanupWorker = ({
  db,
}: BullMqWorkerContext) => {
  const workerConnection = createBullMqConnection();
  const cleanupRequestDeps = createAccountDeletionCleanupRequestDeps(db);

  const worker = new Worker<AccountDeletionCleanupJobData>(
    QUEUE_NAME,
    async (job) => {
      await processAccountDeletionCleanupRequest(
        job.data.requestId,
        cleanupRequestDeps,
      );
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
          const count = await enqueuePendingAccountDeletionCleanupRequests(db);
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
    queues: [QUEUE_NAME] as const,
    close: async () => {
      clearInterval(reconcileInterval);
      await worker.close();
    },
  };
};
