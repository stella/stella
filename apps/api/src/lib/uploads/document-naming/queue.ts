import { and, asc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";

import { Temporal } from "@stll/time";

import type { RootDatabase } from "@/api/db/root";
import { documentNamingRuns } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { createLazyBullMqQueue } from "@/api/lib/bullmq-queue";
import { requeueDeterministicJob } from "@/api/lib/bullmq-requeue";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { transition } from "@/api/lib/db/transitions";
import { DOCUMENT_NAMING_TRANSITIONS } from "@/api/lib/uploads/document-naming/transitions";

export const DOCUMENT_NAMING_QUEUE_NAME = "document-naming";
const DOCUMENT_NAMING_JOB_NAME = "name-document";
const RECOVERY_BATCH_SIZE = 100;
/** A claim older than this is returned to `pending` by recovery. */
const DOCUMENT_NAMING_LEASE_TIMEOUT_MS = 5 * 60 * 1000;

export type DocumentNamingJobData = { runId: SafeId<"documentProcessingRun"> };

const getDocumentNamingQueue = createLazyBullMqQueue<DocumentNamingJobData>({
  name: DOCUMENT_NAMING_QUEUE_NAME,
  connectionOptions: { connectionTimeout: 2000, enableOfflineQueue: false },
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

/** One deterministic job per run; duplicate delivery converges on the claim. */
export const enqueueDocumentNaming = async (
  runId: SafeId<"documentProcessingRun">,
): Promise<void> => {
  await requeueDeterministicJob({
    data: { runId },
    jobId: createBullMqJobId(DOCUMENT_NAMING_QUEUE_NAME, runId),
    name: DOCUMENT_NAMING_JOB_NAME,
    queue: getDocumentNamingQueue(),
  });
};

type RecoverDocumentNamingOptions = {
  database: Pick<RootDatabase, "select" | "transaction">;
  enqueue?: typeof enqueueDocumentNaming;
  limit?: number;
};

/**
 * Return expired claims to `pending` and wake every due pending run. A run is
 * only ever claimed through its fenced transition, so a sweep racing a live
 * worker or another sweep changes nothing.
 */
export const recoverDocumentNamingRuns = async ({
  database,
  enqueue = enqueueDocumentNaming,
  limit = RECOVERY_BATCH_SIZE,
}: RecoverDocumentNamingOptions) => {
  const staleBefore = new Date(
    Temporal.Now.instant().epochMilliseconds - DOCUMENT_NAMING_LEASE_TIMEOUT_MS,
  );
  const expired = await database
    .select({ id: documentNamingRuns.id, attempt: documentNamingRuns.attempt })
    .from(documentNamingRuns)
    .where(
      and(
        eq(documentNamingRuns.status, "running"),
        lt(documentNamingRuns.claimedAt, sql`${staleBefore}::timestamptz`),
      ),
    )
    .orderBy(asc(documentNamingRuns.claimedAt), asc(documentNamingRuns.id))
    .limit(limit);
  let reclaimed = 0;
  for (const run of expired) {
    // db-await-in-loop: each expired claim moves under its own attempt fence; leases expire only when a worker dies.
    const moved = await withAggregateTransaction(
      database,
      async (tx) =>
        await transition({
          tx,
          spec: DOCUMENT_NAMING_TRANSITIONS,
          id: run.id,
          options: {
            from: ["running"],
            to: "pending",
            fence: run.attempt,
            set: {
              claimedAt: null,
              errorCode: "worker_lease_expired",
              updatedAt: new Date(),
            },
          },
          // Lease bookkeeping; the rename a run leads to is audited on its own.
          recordTransitionAuditEvent: async () => await Promise.resolve(),
        }),
    );
    // Stale: a live worker settled it, or another sweep reclaimed it first.
    reclaimed += moved.type === "transitioned" ? 1 : 0;
  }

  const due = await database
    .select({ id: documentNamingRuns.id })
    .from(documentNamingRuns)
    .where(
      and(
        eq(documentNamingRuns.status, "pending"),
        or(
          isNull(documentNamingRuns.skippedUntil),
          lte(documentNamingRuns.skippedUntil, sql`now()`),
        ),
      ),
    )
    .orderBy(asc(documentNamingRuns.updatedAt), asc(documentNamingRuns.id))
    .limit(limit);
  for (const { id } of due) {
    await enqueue(id);
  }
  return {
    count: reclaimed + due.length,
    hasMore: due.length === limit,
  };
};
