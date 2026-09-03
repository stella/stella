import { Result } from "better-result";
import { Worker } from "bullmq";
import { and, asc, eq, isNotNull, lt } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { styleSets } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { createLazyBullMqQueue } from "@/api/lib/bullmq-queue";
import { QUEUE_REQUEUE_OUTCOME } from "@/api/lib/bullmq-requeue";
import type { QueueRequeueOutcome } from "@/api/lib/bullmq-requeue";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { errorTag } from "@/api/lib/errors/utils";
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
}): Promise<QueueRequeueOutcome> => {
  // The job id is derived from the key, so a claim for a key this queue has
  // already handled collides with the retained record of that run. Both
  // terminal states have to be reclaimed, not just `failed`: a claim placed
  // ahead of the write completes as a no-op while the style set is still live,
  // and `removeOnComplete` keeps that record, so a later replacement of the
  // same key would `add()` a duplicate id, BullMQ would ignore it, and the
  // superseded object would be left with no runnable cleanup. A job still
  // waiting, delayed, or active needs no re-add: it is the claim, and saying
  // so is what keeps a sweep from spending its per-tick budget on rows that
  // are already covered — a cleanup waits out the whole download TTL, so a
  // healthy row keeps a live job far longer than a sweep's settle window.
  const jobId = createBullMqJobId(CLEANUP_JOB_NAME, s3Key);
  const existingJob = await cleanupQueue.getJob(jobId);
  if (existingJob) {
    const state = await existingJob.getState();
    if (state !== "completed" && state !== "failed") {
      return QUEUE_REQUEUE_OUTCOME.QUEUE_OWNED;
    }
    await existingJob.remove();
  }

  await cleanupQueue.add(
    CLEANUP_JOB_NAME,
    { s3Key, styleSetId },
    { delay: Math.max(0, delayMs), jobId },
  );
  return QUEUE_REQUEUE_OUTCOME.REQUEUED;
};

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
  db?: Pick<typeof rootDb, "select">;
};

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
  db = rootDb,
}: ReconcilePendingStyleSetPackageCleanupsOptions = {}): Promise<ReconcileScanResult> => {
  const settledBefore = new Date(Date.now() - RECONCILE_SETTLE_MS);

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
                Date.now(),
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
      captureError(outcome.error, { styleSetId: id });
      return false;
    }
    // Only a job this sweep actually added spends budget. A key the queue
    // already holds is covered work, and a cleanup sits delayed for the whole
    // download TTL — far longer than the settle window — so counting those
    // would let a run of healthy rows exhaust the tick before it reached the
    // stranded row behind them.
    return outcome.value === QUEUE_REQUEUE_OUTCOME.REQUEUED;
  };

  return await scanPendingRows({ handle, readPage });
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
  db: Pick<typeof rootDb, "select" | "update"> = rootDb,
): Promise<void> => {
  const [serving] = await db
    .select({ id: styleSets.id })
    .from(styleSets)
    .where(eq(styleSets.s3Key, s3Key))
    .limit(1);
  if (serving) {
    logger.debug("style_set_package_cleanup.still_referenced", {
      styleSetId: serving.id,
    });
    return;
  }
  await getS3().delete(s3Key);
  // audit: skip — cleanup metadata on the already-audited style set.
  await db
    .update(styleSets)
    .set({ cleanupS3Key: null })
    .where(eq(styleSets.cleanupS3Key, s3Key));
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
