import { Result, UnhandledException } from "better-result";
import { Queue, Worker } from "bullmq";
import { and, asc, eq, lt, lte, or, sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { entityDeletionCleanupRequests } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { detached } from "@/api/lib/detached";
import { connectionErrorFields, errorTag } from "@/api/lib/errors/utils";
import { deleteS3Keys } from "@/api/lib/files/utils";
import { logger } from "@/api/lib/observability/logger";
import { createBullMqConnection } from "@/api/lib/redis-client";
import { withTimeout } from "@/api/lib/with-timeout";

const QUEUE_NAME = "entity-deletion-cleanup";
const STORAGE_CLEANUP_JOB_NAME = "storage-cleanup";
const DEFAULT_JOB_ATTEMPTS = 5;
const WORKER_CONCURRENCY = 2;
const RECONCILE_INTERVAL_MS = 60_000;
const STALE_PROCESSING_MS = 15 * 60_000;
const RECONCILE_BATCH_SIZE = 50;
const RETRY_BASE_DELAY_MS = 60_000;
const RETRY_MAX_DELAY_MS = 24 * 60 * 60_000;
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
  deleteS3Keys: typeof deleteS3Keys;
  logger: Pick<typeof logger, "warn">;
  rootDb: Pick<typeof rootDb, "select" | "update">;
  storageDeleteTimeoutMs: number;
};

const defaultCleanupRequestDeps: EntityDeletionCleanupRequestDeps = {
  deleteS3Keys,
  logger,
  rootDb,
  storageDeleteTimeoutMs: STORAGE_DELETE_TIMEOUT_MS,
};

let queue: Queue<EntityDeletionCleanupJobData> | null = null;
let queueConnection: ReturnType<typeof createBullMqConnection> | null = null;

const getQueueConnection = () => {
  queueConnection ??= createBullMqConnection({
    connectionTimeout: QUEUE_OPERATION_TIMEOUT_MS,
    enableOfflineQueue: false,
  });
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
  status?: (typeof entityDeletionCleanupRequests.$inferSelect)["status"],
): Promise<void> => {
  const durableStatus =
    status ??
    (await rootDb
      .select({ status: entityDeletionCleanupRequests.status })
      .from(entityDeletionCleanupRequests)
      .where(eq(entityDeletionCleanupRequests.id, requestId))
      .limit(1)
      .then((rows) => rows.at(0)?.status));
  if (!durableStatus || durableStatus === "completed") {
    return;
  }
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

  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_PROCESSING_MS);
  const claimed = await deps.rootDb
    .update(entityDeletionCleanupRequests)
    .set({
      attemptCount: sql`${entityDeletionCleanupRequests.attemptCount} + 1`,
      errorMessage: null,
      nextAttemptAt: null,
      status: "processing",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(entityDeletionCleanupRequests.id, requestId),
        or(
          eq(entityDeletionCleanupRequests.status, "pending"),
          and(
            eq(entityDeletionCleanupRequests.status, "failed"),
            lte(entityDeletionCleanupRequests.nextAttemptAt, now),
          ),
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

  const deleteAttempt = await Result.tryPromise({
    try: async () =>
      await withTimeout(async () => await deps.deleteS3Keys(claim.s3Keys), {
        label: STORAGE_DELETE_TIMEOUT_LABEL,
        timeoutMs: deps.storageDeleteTimeoutMs,
      }),
    catch: (cause) =>
      cause instanceof Error ? cause : new UnhandledException({ cause }),
  });
  let deleteError: Error | null = null;
  if (Result.isError(deleteAttempt)) {
    deleteError = deleteAttempt.error;
  } else if (Result.isError(deleteAttempt.value)) {
    deleteError = deleteAttempt.value.error;
  }
  if (deleteError !== null) {
    const failedAt = new Date();
    await deps.rootDb
      .update(entityDeletionCleanupRequests)
      .set({
        errorMessage: deleteError.message,
        nextAttemptAt: getEntityDeletionCleanupRetryAt({
          attemptCount: claim.attemptCount,
          now: failedAt,
        }),
        status: "failed",
        updatedAt: failedAt,
      })
      .where(
        and(
          eq(entityDeletionCleanupRequests.id, requestId),
          eq(entityDeletionCleanupRequests.status, "processing"),
          eq(entityDeletionCleanupRequests.attemptCount, claim.attemptCount),
        ),
      );
    throw deleteError;
  }

  await deps.rootDb
    .update(entityDeletionCleanupRequests)
    .set({
      completedAt: new Date(),
      errorMessage: null,
      nextAttemptAt: null,
      s3Keys: [],
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

export const getEntityDeletionCleanupRetryAt = ({
  attemptCount,
  now,
}: {
  attemptCount: number;
  now: Date;
}): Date => {
  const exponent = Math.min(Math.max(attemptCount - 1, 0), 30);
  const delayMs = Math.min(
    RETRY_BASE_DELAY_MS * 2 ** exponent,
    RETRY_MAX_DELAY_MS,
  );
  return new Date(now.getTime() + delayMs);
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
    const now = new Date();
    const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);
    const pendingRows = await rootDb
      .select({ id: entityDeletionCleanupRequests.id })
      .from(entityDeletionCleanupRequests)
      .where(eq(entityDeletionCleanupRequests.status, "pending"))
      .orderBy(
        asc(entityDeletionCleanupRequests.createdAt),
        asc(entityDeletionCleanupRequests.id),
      )
      .limit(RECONCILE_BATCH_SIZE);
    const failedRows = await rootDb
      .select({ id: entityDeletionCleanupRequests.id })
      .from(entityDeletionCleanupRequests)
      .where(
        and(
          eq(entityDeletionCleanupRequests.status, "failed"),
          lte(entityDeletionCleanupRequests.nextAttemptAt, now),
        ),
      )
      .orderBy(
        asc(entityDeletionCleanupRequests.nextAttemptAt),
        asc(entityDeletionCleanupRequests.id),
      )
      .limit(RECONCILE_BATCH_SIZE);
    const staleRows = await rootDb
      .select({ id: entityDeletionCleanupRequests.id })
      .from(entityDeletionCleanupRequests)
      .where(
        and(
          eq(entityDeletionCleanupRequests.status, "processing"),
          lt(entityDeletionCleanupRequests.updatedAt, staleBefore),
        ),
      )
      .orderBy(
        asc(entityDeletionCleanupRequests.updatedAt),
        asc(entityDeletionCleanupRequests.id),
      )
      .limit(RECONCILE_BATCH_SIZE);

    await deliverEntityDeletionCleanupCandidates({
      failedIds: failedRows.map(({ id }) => id),
      pendingIds: pendingRows.map(({ id }) => id),
      processingIds: staleRows.map(({ id }) => id),
    });
    return pendingRows.length + failedRows.length + staleRows.length;
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

  const reconcile = createEntityDeletionCleanupReconciler({
    run: async () => {
      await enqueuePendingEntityDeletionCleanupRequests();
    },
    onError: (error) => {
      captureError(error);
      logger.error("entity_deletion_cleanup.reconcile_failed", {
        "error.type": errorTag(error),
      });
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
