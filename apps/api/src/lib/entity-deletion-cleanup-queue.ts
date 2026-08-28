import { Result, UnhandledException } from "better-result";
import { type Queue, Worker } from "bullmq";

import type { EntityDeletionCleanupStatus } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { createLazyBullMqQueue } from "@/api/lib/bullmq-queue";
import { detached } from "@/api/lib/detached";
import {
  claimNextEntityDeletionEffectChunk,
  completeEntityDeletionEffectChunk,
  ensureEntityDeletionEffectChunks,
  failEntityDeletionEffectChunk,
  listRecoverableEntityDeletionEffectRequestIds,
} from "@/api/lib/entity-deletion-effect-store";
import { errorSystemFields, errorTag } from "@/api/lib/errors/utils";
import { deleteS3Keys } from "@/api/lib/files/utils";
import { logger } from "@/api/lib/observability/logger";
import { createQueueWorkerErrorLogger } from "@/api/lib/queue-worker-error-log";
import { createBullMqConnection } from "@/api/lib/redis-client";
import { withTimeout } from "@/api/lib/with-timeout";

export { getDestructiveEffectRetryAt as getEntityDeletionCleanupRetryAt } from "@/api/lib/destructive-effect-chunks";

const QUEUE_NAME = "entity-deletion-cleanup";
const STORAGE_CLEANUP_JOB_NAME = "storage-cleanup";
const DEFAULT_JOB_ATTEMPTS = 5;
const WORKER_CONCURRENCY = 2;
const RECONCILE_INTERVAL_MS = 60_000;
const MAX_CHUNKS_PER_JOB = 10;
const STORAGE_DELETE_TIMEOUT_MS = 10 * 60_000;
const STORAGE_DELETE_TIMEOUT_LABEL = "entity-deletion-cleanup.storage-delete";
const QUEUE_OPERATION_TIMEOUT_MS = 2000;

type EntityDeletionCleanupJobData = {
  requestId: SafeId<"entityDeletionCleanupRequest">;
};

type EntityDeletionCleanupQueue = Pick<
  Queue<EntityDeletionCleanupJobData>,
  "add" | "getJob"
>;

type EntityDeletionCleanupRequestDeps = {
  claimChunk: typeof claimNextEntityDeletionEffectChunk;
  completeChunk: typeof completeEntityDeletionEffectChunk;
  deleteS3Keys: typeof deleteS3Keys;
  ensureChunks: typeof ensureEntityDeletionEffectChunks;
  failChunk: typeof failEntityDeletionEffectChunk;
  storageDeleteTimeoutMs: number;
};

const defaultCleanupRequestDeps: EntityDeletionCleanupRequestDeps = {
  claimChunk: claimNextEntityDeletionEffectChunk,
  completeChunk: completeEntityDeletionEffectChunk,
  deleteS3Keys,
  ensureChunks: ensureEntityDeletionEffectChunks,
  failChunk: failEntityDeletionEffectChunk,
  storageDeleteTimeoutMs: STORAGE_DELETE_TIMEOUT_MS,
};

const getQueue = createLazyBullMqQueue<EntityDeletionCleanupJobData>({
  name: QUEUE_NAME,
  connectionOptions: {
    connectionTimeout: QUEUE_OPERATION_TIMEOUT_MS,
    enableOfflineQueue: false,
  },
  defaultJobOptions: {
    attempts: DEFAULT_JOB_ATTEMPTS,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

export const enqueueEntityDeletionCleanup = async (
  requestId: SafeId<"entityDeletionCleanupRequest">,
  _status?: EntityDeletionCleanupStatus,
): Promise<void> => {
  await enqueueEntityDeletionCleanupJob({
    cleanupQueue: getQueue(),
    requestId,
  });
};

export const enqueueEntityDeletionCleanupJob = async ({
  cleanupQueue,
  operationTimeoutMs = QUEUE_OPERATION_TIMEOUT_MS,
  requestId,
}: {
  cleanupQueue: EntityDeletionCleanupQueue;
  operationTimeoutMs?: number;
  requestId: SafeId<"entityDeletionCleanupRequest">;
}): Promise<void> => {
  const jobId = createBullMqJobId(requestId, STORAGE_CLEANUP_JOB_NAME);
  const existingJob = await withTimeout(
    async () => await cleanupQueue.getJob(jobId),
    {
      label: "entity-deletion-cleanup.queue.get-job",
      timeoutMs: operationTimeoutMs,
    },
  );
  if (existingJob) {
    const state = await withTimeout(async () => await existingJob.getState(), {
      label: "entity-deletion-cleanup.queue.get-state",
      timeoutMs: operationTimeoutMs,
    });
    if (state === "failed" || state === "completed") {
      await withTimeout(async () => await existingJob.remove(), {
        label: "entity-deletion-cleanup.queue.remove-job",
        timeoutMs: operationTimeoutMs,
      });
    } else {
      return;
    }
  }

  await withTimeout(
    async () =>
      await cleanupQueue.add(
        STORAGE_CLEANUP_JOB_NAME,
        { requestId },
        { jobId },
      ),
    {
      label: "entity-deletion-cleanup.queue.add-job",
      timeoutMs: operationTimeoutMs,
    },
  );
};

export const createEntityDeletionCleanupReconciler = ({
  onError,
  run,
}: {
  onError: (error: unknown) => void;
  run: () => Promise<void>;
}): (() => void) => {
  let reconciling = false;
  return () => {
    if (reconciling) {
      return;
    }
    reconciling = true;
    detached(
      (async () => {
        try {
          await run();
        } catch (error) {
          onError(error);
        } finally {
          reconciling = false;
        }
      })(),
      "entity-deletion-cleanup.reconcile",
    );
  };
};

type DrainEntityDeletionEffectsParams = {
  deps: EntityDeletionCleanupRequestDeps;
  remaining: number;
  requestId: SafeId<"entityDeletionCleanupRequest">;
};

const drainEntityDeletionEffects = async ({
  deps,
  remaining,
  requestId,
}: DrainEntityDeletionEffectsParams): Promise<void> => {
  if (remaining === 0) {
    return;
  }
  const claim = await deps.claimChunk(requestId);
  if (!claim) {
    return;
  }
  const deleteAttempt = await Result.tryPromise({
    try: async () =>
      await withTimeout(async () => await deps.deleteS3Keys(claim.s3Keys), {
        label: STORAGE_DELETE_TIMEOUT_LABEL,
        timeoutMs: deps.storageDeleteTimeoutMs,
      }),
    catch: (cause) =>
      cause instanceof Error ? cause : new UnhandledException({ cause }),
  });
  let deleteError = Result.isError(deleteAttempt) ? deleteAttempt.error : null;
  if (!Result.isError(deleteAttempt) && Result.isError(deleteAttempt.value)) {
    deleteError = deleteAttempt.value.error;
  }
  if (deleteError !== null) {
    await deps.failChunk(claim, deleteError);
    throw deleteError;
  }
  await deps.completeChunk(claim);
  await drainEntityDeletionEffects({
    deps,
    remaining: remaining - 1,
    requestId,
  });
};

export const processEntityDeletionCleanupRequest = async (
  requestId: SafeId<"entityDeletionCleanupRequest">,
  deps: EntityDeletionCleanupRequestDeps = defaultCleanupRequestDeps,
): Promise<void> => {
  await deps.ensureChunks(requestId);
  await drainEntityDeletionEffects({
    deps,
    remaining: MAX_CHUNKS_PER_JOB,
    requestId,
  });
};

const settleEntityDeletionCleanupDeliveryPhase = async ({
  candidateIds,
  enqueueCleanup = enqueueEntityDeletionCleanup,
  status,
}: {
  candidateIds: SafeId<"entityDeletionCleanupRequest">[];
  enqueueCleanup?: typeof enqueueEntityDeletionCleanup;
  status: "failed" | "pending" | "processing";
}): Promise<Error[]> => {
  const deliveryResults = await Promise.all(
    candidateIds.map(
      async (id) =>
        await Result.tryPromise({
          try: async () => await enqueueCleanup(id, status),
          catch: (cause) =>
            cause instanceof Error ? cause : new UnhandledException({ cause }),
        }),
    ),
  );
  return deliveryResults.flatMap((deliveryResult) => {
    if (Result.isOk(deliveryResult)) {
      return [];
    }
    return [deliveryResult.error];
  });
};

export const deliverEntityDeletionCleanupCandidates = async ({
  failedIds,
  enqueueCleanup = enqueueEntityDeletionCleanup,
  pendingIds,
  processingIds,
}: {
  failedIds: SafeId<"entityDeletionCleanupRequest">[];
  enqueueCleanup?: typeof enqueueEntityDeletionCleanup;
  pendingIds: SafeId<"entityDeletionCleanupRequest">[];
  processingIds: SafeId<"entityDeletionCleanupRequest">[];
}): Promise<void> => {
  const errors = [
    ...(await settleEntityDeletionCleanupDeliveryPhase({
      candidateIds: pendingIds,
      enqueueCleanup,
      status: "pending",
    })),
    ...(await settleEntityDeletionCleanupDeliveryPhase({
      candidateIds: failedIds,
      enqueueCleanup,
      status: "failed",
    })),
    ...(await settleEntityDeletionCleanupDeliveryPhase({
      candidateIds: processingIds,
      enqueueCleanup,
      status: "processing",
    })),
  ];
  const firstError = errors.at(0);
  if (firstError) {
    throw firstError;
  }
};

export const enqueuePendingEntityDeletionCleanupRequests =
  async (): Promise<number> => {
    const requestIds = await listRecoverableEntityDeletionEffectRequestIds();
    await Promise.all(
      requestIds.map(async (id) => await enqueueEntityDeletionCleanup(id)),
    );
    return requestIds.length;
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
  worker.on(
    "error",
    createQueueWorkerErrorLogger("entity_deletion_cleanup.worker_error"),
  );

  const reconcile = createEntityDeletionCleanupReconciler({
    run: async () => {
      await enqueuePendingEntityDeletionCleanupRequests();
    },
    onError: (error) => {
      captureError(error);
      logger.error(
        "entity_deletion_cleanup.reconcile_failed",
        errorSystemFields(error),
      );
    },
  });
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
