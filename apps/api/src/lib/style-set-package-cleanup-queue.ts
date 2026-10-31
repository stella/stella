import { Result, TaggedError } from "better-result";
import { and, asc, eq, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";

import { backoffDelay } from "@stll/concurrency/backoff-delay";
import { Temporal } from "@stll/time";

import type { rootDb } from "@/api/db/root";
import { styleSets } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { BullMqWorker, createLazyBullMqQueue } from "@/api/lib/bullmq-queue";
import type { BullMqWorkerContext } from "@/api/lib/bullmq-queue";
import {
  QUEUE_REQUEUE_OUTCOME,
  requeueDeterministicJob,
} from "@/api/lib/bullmq-requeue";
import type {
  QueueRequeueOutcome,
  RequeueableQueue,
} from "@/api/lib/bullmq-requeue";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { errorTag } from "@/api/lib/errors/utils";
import { deleteOrganizationFileWithSignal } from "@/api/lib/files/delete-organization-file";
import { logger } from "@/api/lib/observability/logger";
import {
  RECONCILE_SCAN_PAGE_SIZE,
  reconcileCursorTimestamp,
  scanPendingRows,
} from "@/api/lib/queue-reconcile-scan";
import type { ReconcileScanResult } from "@/api/lib/queue-reconcile-scan";
import { createQueueWorkerErrorLogger } from "@/api/lib/queue-worker-error-log";
import { createBullMqConnection } from "@/api/lib/redis-client";
import { getS3 } from "@/api/lib/s3";
import { brandPersistedStyleSetId } from "@/api/lib/safe-id-boundaries";
import { STYLE_SET_DOWNLOAD_TTL_SECONDS } from "@/api/lib/style-sets";
import { withTimeout } from "@/api/lib/with-timeout";

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

type StyleSetPackageCleanupQueue =
  RequeueableQueue<StyleSetPackageCleanupJobData>;

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
}: EnqueueStyleSetPackageCleanupOptions): Promise<void> => {
  // The request path only needs the claim to exist; which of the two ways it
  // came to exist changes nothing it does next.
  await enqueueStyleSetPackageCleanupJob({
    cleanupQueue: getQueue(),
    delayMs,
    s3Key,
    styleSetId,
  });
};

// The job id is derived from the key, so a claim for a key this queue has
// already handled meets the kept record of that run: a claim placed ahead
// of the write completes as a no-op while the style set is still live, and
// `removeOnComplete` keeps that record. A job still waiting, delayed, or active
// is the claim, and saying so is what keeps a sweep from spending its per-tick
// budget on rows that are already covered — a cleanup waits out the whole
// download TTL, so a healthy row keeps a live job far longer than a sweep's
// settle window.
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
}): Promise<QueueRequeueOutcome> =>
  await requeueDeterministicJob({
    data: { s3Key, styleSetId },
    delayMs,
    jobId: createBullMqJobId(CLEANUP_JOB_NAME, s3Key),
    name: CLEANUP_JOB_NAME,
    queue: cleanupQueue,
  });

/**
 * How long a row may name a superseded package before the sweep takes it over.
 * Only has to outlast the request that enqueues the cleanup, so the sweep
 * never races a handoff that is still running.
 */
const RECONCILE_SETTLE_MS = 5 * 60 * 1000;

/**
 * Deadline on one sweep handoff. The three queue commands behind it are
 * unbounded on their own, and a sweep that sat on an unanswered one would
 * spend its whole scheduler lease on a single row. Matches the bound the
 * other queue handoffs use.
 */
const QUEUE_HANDOFF_TIMEOUT_MS = 2000;
const DELETED_STYLE_SET_CLEANUP_BATCH_SIZE = 32;
const DELETED_STYLE_SET_CLEANUP_CONCURRENCY = 4;
const DELETED_STYLE_SET_RETRY_BASE_SECONDS = 60;
const DELETED_STYLE_SET_RETRY_MAX_SECONDS = 24 * 60 * 60;
const PACKAGE_CLEANUP_OUTCOME = {
  removed: "removed",
  liveReference: "live-reference",
} as const;
type PackageCleanupOutcome =
  (typeof PACKAGE_CLEANUP_OUTCOME)[keyof typeof PACKAGE_CLEANUP_OUTCOME];

/** The (timestamp, id) keyset this sweep's walk pages on. */
const styleSetCleanupCursorCodec = createTimestampIdCursorCodec({
  column: styleSets.updatedAt,
  brandId: brandPersistedStyleSetId,
});

type PendingCleanupRow = {
  cleanupS3Key: string | null;
  id: SafeId<"styleSet">;
  updatedAt: Date;
  updatedCursor: string;
};

type ReconcilePendingStyleSetPackageCleanupsOptions = {
  cleanupQueue?: StyleSetPackageCleanupQueue;
  db: Pick<typeof rootDb, "select">;
};

type StyleSetPackageCleanupReconcileResult = ReconcileScanResult & {
  failed: number;
};

export class StyleSetPackageCleanupRequeueError extends TaggedError(
  "StyleSetPackageCleanupRequeueError",
)<{
  cause: unknown;
  message: string;
  summary: StyleSetPackageCleanupReconcileResult;
}> {}

type DeletedStyleSetCleanupResult = {
  cleaned: number;
  failed: number;
  scanned: number;
};

export class DeletedStyleSetCleanupError extends TaggedError(
  "DeletedStyleSetCleanupError",
)<{
  cause: unknown;
  message: string;
  summary: DeletedStyleSetCleanupResult;
}> {}

/**
 * Re-drive package cleanups a row still owes.
 *
 * `cleanup_s3_key` is the durable record that a superseded package is waiting
 * to be deleted: the replacement transaction writes it and the request enqueues
 * the job after committing. A crash or a lost job in between strands the object
 * in storage, and the column it left behind also blocks the next replacement of
 * that style set, so the row needs no new state to be recoverable — it already
 * names exactly the work that is owed. The enqueue is keyed by the object key,
 * so repeating it collapses onto the job already waiting.
 *
 * The sweep only enqueues. Releasing the marker is the job's to do once the
 * object is actually gone: with a delay this sweep may compute as zero, the job
 * can run and skip before any release here lands, and the release would then
 * have thrown away the only record that the deletion is still owed.
 */
export const reconcilePendingStyleSetPackageCleanups = async ({
  cleanupQueue = getQueue(),
  db,
}: ReconcilePendingStyleSetPackageCleanupsOptions): Promise<
  Result<
    StyleSetPackageCleanupReconcileResult,
    StyleSetPackageCleanupRequeueError
  >
> => {
  let failure: { cause: unknown; count: number } | undefined;
  // The scan's concurrent handlers update this state across an await.
  const readFailure = () => failure;
  const settledBefore = new Date(
    Temporal.Now.instant().epochMilliseconds - RECONCILE_SETTLE_MS,
  );

  const after = (cursor: PendingCleanupRow | null) => {
    if (cursor === null) {
      return undefined;
    }
    return styleSetCleanupCursorCodec.keysetAfter({
      cursor: {
        timestamp: reconcileCursorTimestamp(cursor.updatedCursor),
        id: cursor.id,
      },
      idColumn: styleSets.id,
      direction: "ascending",
    });
  };

  const readPage = async (cursor: PendingCleanupRow | null) =>
    await db
      .select({
        cleanupS3Key: styleSets.cleanupS3Key,
        id: styleSets.id,
        updatedAt: styleSets.updatedAt,
        updatedCursor: styleSetCleanupCursorCodec.cursorValue,
      })
      .from(styleSets)
      .where(
        and(
          isNotNull(styleSets.cleanupS3Key),
          isNull(styleSets.deletedAt),
          lt(styleSets.updatedAt, settledBefore),
          after(cursor),
        ),
      )
      .orderBy(asc(styleSets.updatedAt), asc(styleSets.id))
      .limit(RECONCILE_SCAN_PAGE_SIZE);

  const handle = async ({
    cleanupS3Key,
    id,
    updatedAt,
  }: PendingCleanupRow): Promise<boolean> => {
    if (cleanupS3Key === null) {
      return false;
    }
    const outcome = await Result.tryPromise({
      // Bounded here rather than inside the handoff itself: the request path
      // shares that helper and owns its own failure handling, while a sweep
      // that sat on an unanswered queue command would spend its whole lease on
      // one row and record nothing.
      try: async () =>
        await withTimeout(
          async () =>
            await enqueueStyleSetPackageCleanupJob({
              cleanupQueue,
              // The download URL handed out before the replacement is still
              // live until this deadline; deleting sooner would break it.
              delayMs:
                updatedAt.getTime() +
                STYLE_SET_DOWNLOAD_TTL_SECONDS * 1000 -
                Temporal.Now.instant().epochMilliseconds,
              s3Key: cleanupS3Key,
              styleSetId: id,
            }),
          {
            label: "style-set-package-cleanup.reconcile-handoff",
            timeoutMs: QUEUE_HANDOFF_TIMEOUT_MS,
          },
        ),
      catch: (cause) => cause,
    });
    if (Result.isError(outcome)) {
      failure = {
        cause: failure === undefined ? outcome.error : failure.cause,
        count: (failure?.count ?? 0) + 1,
      };
      // The scheduler runner captures the aggregate failure once per tick.
      logger.warn("style_set.package_cleanup_requeue_failed", {
        stage: "requeue",
        styleSetId: id,
      });
      return false;
    }
    // Only a job this sweep actually added spends budget. A key the queue
    // already holds is covered work, and a cleanup sits delayed for the whole
    // download TTL — far longer than the settle window — so counting those
    // would let a run of healthy rows exhaust the tick before it reached the
    // stranded row behind them.
    return outcome.value === QUEUE_REQUEUE_OUTCOME.REQUEUED;
  };

  const scan = await scanPendingRows({ handle, readPage });
  const queueFailure = readFailure();
  const summary = { ...scan, failed: queueFailure?.count ?? 0 };
  if (queueFailure !== undefined) {
    return Result.err(
      new StyleSetPackageCleanupRequeueError({
        cause: queueFailure.cause,
        message: "Requeueing style set package cleanups did not complete",
        summary,
      }),
    );
  }
  return Result.ok(summary);
};

/**
 * Delete a package object unless a style set still serves it.
 *
 * The check is what makes a cleanup job safe to enqueue *before* the object
 * exists: an abandoned write is deleted, while a write whose row committed is
 * left alone, and no ordering between the two decides the outcome. Only
 * `s3_key` protects an object. A `cleanup_s3_key` naming it is the opposite
 * signal — the row is asking for exactly this deletion — so the job clears
 * that marker once the object is gone, and only for the key it deleted. The
 * marker is what the sweep rediscovers, so releasing it before the deletion
 * lands would destroy the only durable record of the retry.
 */
export const deleteUnreferencedStyleSetPackage = async (
  s3Key: string,
  db: Pick<typeof rootDb, "select" | "update">,
): Promise<PackageCleanupOutcome> => {
  const [serving] = await db
    .select({ id: styleSets.id })
    .from(styleSets)
    .where(and(eq(styleSets.s3Key, s3Key), isNull(styleSets.deletedAt)))
    .limit(1);
  if (serving) {
    logger.debug("style_set_package_cleanup.still_referenced", {
      styleSetId: serving.id,
    });
    return PACKAGE_CLEANUP_OUTCOME.liveReference;
  }
  if (isDeploymentFeatureEnabled("FEATURE_FILE_USAGE_LIMITS")) {
    const deleted = await deleteOrganizationFileWithSignal(
      s3Key,
      AbortSignal.timeout(10_000),
    );
    deleted.unwrap(
      "Unreferenced style set package deletion must succeed before clearing its cleanup key",
    );
  } else {
    await getS3().delete(s3Key);
  }
  // audit: skip — cleanup metadata on the already-audited style set.
  await db
    .update(styleSets)
    .set({ cleanupS3Key: null })
    .where(eq(styleSets.cleanupS3Key, s3Key));
  return PACKAGE_CLEANUP_OUTCOME.removed;
};

type ReconcileDeletedStyleSetPackagesOptions = {
  db: Pick<typeof rootDb, "delete" | "select" | "update">;
  deletePackage?: typeof deleteUnreferencedStyleSetPackage;
  /** Tombstones per run; the next scheduler run takes the rest. */
  limit?: number;
};

const getDeletedStyleSetCleanupRetryAt = ({
  attemptCount,
  now,
}: {
  attemptCount: number;
  now: Date;
}): Date => {
  const exponent = Math.min(Math.max(attemptCount - 1, 0), 30);
  const delaySeconds = backoffDelay(exponent, {
    baseMs: DELETED_STYLE_SET_RETRY_BASE_SECONDS,
    maxMs: DELETED_STYLE_SET_RETRY_MAX_SECONDS,
  });
  return new Date(now.getTime() + delaySeconds * 1000);
};

/**
 * Consume committed style-set deletion tombstones.
 *
 * The deleting transaction leaves the exact current and superseded object
 * keys on the soft-deleted row. That row is the outbox: it survives request
 * interruption and storage failure, and is removed only after every key is
 * erased or another live style set owns it. Replacement and deletion take the
 * same advisory fence before publishing the tombstone, so these keys cannot
 * change underneath the cleanup. Storage deletes and accounting removal are
 * replay safe, so overlapping scheduler runs converge on the same row delete.
 */
export const reconcileDeletedStyleSetPackages = async ({
  db,
  deletePackage = deleteUnreferencedStyleSetPackage,
  limit = DELETED_STYLE_SET_CLEANUP_BATCH_SIZE,
}: ReconcileDeletedStyleSetPackagesOptions): Promise<
  Result<DeletedStyleSetCleanupResult, DeletedStyleSetCleanupError>
> => {
  const now = new Date();
  const rows = await db
    .select({
      attemptCount: styleSets.deletionCleanupAttemptCount,
      cleanupS3Key: styleSets.cleanupS3Key,
      id: styleSets.id,
      s3Key: styleSets.s3Key,
    })
    .from(styleSets)
    .where(
      and(
        isNotNull(styleSets.deletedAt),
        or(
          isNull(styleSets.deletionCleanupNextAttemptAt),
          lte(styleSets.deletionCleanupNextAttemptAt, now),
        ),
      ),
    )
    .orderBy(
      asc(styleSets.deletionCleanupAttemptCount),
      asc(styleSets.deletedAt),
      asc(styleSets.id),
    )
    .limit(limit);

  let cleaned = 0;
  let failed = 0;
  let firstCause: unknown;
  let next = 0;

  const cleanNext = async (): Promise<void> => {
    const row = rows.at(next);
    next += 1;
    if (row === undefined) {
      return;
    }

    const scheduleRetry = async (): Promise<void> => {
      const retryAt = getDeletedStyleSetCleanupRetryAt({
        attemptCount: row.attemptCount + 1,
        now: new Date(),
      });
      const recorded = await Result.tryPromise({
        try: async () => {
          // audit: skip - retry metadata for an already audited deletion tombstone
          const updated = await db
            .update(styleSets)
            .set({
              deletionCleanupAttemptCount: sql`${styleSets.deletionCleanupAttemptCount} + 1`,
              deletionCleanupNextAttemptAt: retryAt,
            })
            .where(
              and(
                eq(styleSets.id, row.id),
                eq(styleSets.deletionCleanupAttemptCount, row.attemptCount),
                isNotNull(styleSets.deletedAt),
              ),
            );
          return updated;
        },
        catch: (cause) => cause,
      });
      if (Result.isError(recorded)) {
        firstCause ??= recorded.error;
        logger.warn("style_set.deletion_cleanup_retry_write_failed", {
          stage: "retry-state",
          styleSetId: row.id,
        });
      }
    };

    const outcome = await Result.tryPromise({
      try: async () => {
        const keys =
          row.cleanupS3Key === null
            ? [row.s3Key]
            : [row.s3Key, row.cleanupS3Key];
        // db-await-in-loop: at most two packages per claimed row, in a bounded claim batch.
        await Promise.all(
          keys.map(async (s3Key) => await deletePackage(s3Key, db)),
        );

        // audit: skip — consumes storage cleanup for the already-audited
        // style-set deletion.
        await db
          .delete(styleSets)
          .where(
            and(
              eq(styleSets.id, row.id),
              eq(styleSets.s3Key, row.s3Key),
              isNotNull(styleSets.deletedAt),
            ),
          );
      },
      catch: (cause) => cause,
    });

    if (Result.isError(outcome)) {
      firstCause ??= outcome.error;
      failed += 1;
      await scheduleRetry();
      logger.warn("style_set.deletion_cleanup_failed", {
        stage: "storage",
        styleSetId: row.id,
      });
    } else {
      cleaned += 1;
    }
    await cleanNext();
  };

  await Promise.all(
    Array.from(
      {
        length: Math.min(DELETED_STYLE_SET_CLEANUP_CONCURRENCY, rows.length),
      },
      cleanNext,
    ),
  );

  const summary = {
    cleaned,
    failed,
    scanned: rows.length,
  };
  if (firstCause !== undefined) {
    return Result.err(
      new DeletedStyleSetCleanupError({
        cause: firstCause,
        message: "Deleting style set packages did not complete",
        summary,
      }),
    );
  }
  return Result.ok(summary);
};

export const initStyleSetPackageCleanupWorker = ({
  db,
}: BullMqWorkerContext) => {
  const workerConnection = createBullMqConnection({
    storeClass: "durable-coordination",
  });
  const worker = new BullMqWorker<StyleSetPackageCleanupJobData>(
    QUEUE_NAME,
    async (job) => {
      await deleteUnreferencedStyleSetPackage(job.data.s3Key, db);
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

  return {
    queues: [QUEUE_NAME] as const,
    close: async () => {
      await worker.close();
    },
  };
};
