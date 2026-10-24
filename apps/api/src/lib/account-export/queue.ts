import { panic, Result } from "better-result";

import { Temporal } from "@stll/time";

import {
  ACCOUNT_EXPORT_ARCHIVE_LIMITS,
  AccountExportArchiveError,
  buildAccountExportArchive,
} from "@/api/lib/account-export/archive";
import {
  ACCOUNT_EXPORT_QUEUE_NAME,
  enqueueAccountExport,
} from "@/api/lib/account-export/enqueue";
import type { AccountExportJob } from "@/api/lib/account-export/enqueue";
import type { AccountExportDataDb } from "@/api/lib/account-export/pages";
import type { AccountExportProjections } from "@/api/lib/account-export/projections";
import {
  canReclaimAccountExportAttempt,
  canReclaimAccountExportObjects,
  claimAccountExport,
  clearAccountExportObjects,
  completeAccountExport,
  expireAccountExport,
  failAccountExport,
  listRecoverableAccountExports,
} from "@/api/lib/account-export/store";
import type {
  AccountExportClaim,
  AccountExportDb,
  AccountExportRow,
} from "@/api/lib/account-export/store";
import { detached } from "@/api/lib/analytics/capture";
import { BullMqWorker } from "@/api/lib/bullmq-queue";
import type { BullMqWorkerContext } from "@/api/lib/bullmq-queue";
import { deleteS3Keys } from "@/api/lib/files/utils";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import {
  encodePaginationCursor,
  iterateCursorPages,
} from "@/api/lib/pagination";
import { createQueueWorkerErrorLogger } from "@/api/lib/queue-worker-error-log";
import { createBullMqConnection } from "@/api/lib/redis-client";

const WORKER_CONCURRENCY = 1;
const RECONCILE_INTERVAL_MS = 60_000;
const RECOVERY_PAGES_PER_TICK = 10;
const STORAGE_CLEANUP_TIMEOUT_MS = 30_000;

const BUILD_FAILED_SINK = failureSink({
  event: "account_export.build_failed",
  expected: [],
});
const JOB_FAILED_SINK = failureSink({
  event: "account_export.job_failed",
  expected: [],
});
const RECOVERY_FAILED_SINK = failureSink({
  event: "account_export.recovery_failed",
  expected: [],
});

type AccountExportFailureContext = { jobId?: string };
const observeBuildFailure = (
  error: unknown,
  ctx: AccountExportFailureContext,
): void => {
  observeFailure(error, { sink: BUILD_FAILED_SINK, ctx });
};

type AccountExportWorkerDb = AccountExportDataDb & AccountExportDb;

export type AccountExportProcessDeps = {
  claim: typeof claimAccountExport;
  build: (
    options: Omit<
      Parameters<typeof buildAccountExportArchive>[0],
      "projections" | "deps"
    >,
  ) => Promise<void>;
  complete: typeof completeAccountExport;
  fail: typeof failAccountExport;
  canReclaim: typeof canReclaimAccountExportAttempt;
  deleteObjects: typeof deleteS3Keys;
  capture: (error: unknown, ctx: AccountExportFailureContext) => void;
};

const createProcessDeps = (
  projections: AccountExportProjections,
): AccountExportProcessDeps => ({
  claim: claimAccountExport,
  build: async (options) =>
    await buildAccountExportArchive({ ...options, projections }),
  complete: completeAccountExport,
  fail: failAccountExport,
  canReclaim: canReclaimAccountExportAttempt,
  deleteObjects: deleteS3Keys,
  capture: observeBuildFailure,
});

type ReclaimAccountExportAttemptOptions = {
  claim: AccountExportClaim;
  db: AccountExportDb;
  deps: AccountExportProcessDeps;
};

const reclaimAccountExportAttempt = async ({
  claim,
  db,
  deps,
}: ReclaimAccountExportAttemptOptions): Promise<void> => {
  if (!(await deps.canReclaim(claim, db))) {
    return;
  }
  const deleted = await deps.deleteObjects(
    [claim.objectKey],
    AbortSignal.timeout(STORAGE_CLEANUP_TIMEOUT_MS),
  );
  if (Result.isError(deleted)) {
    throw deleted.error;
  }
};

type ProcessAccountExportOptions = {
  id: string;
  db: AccountExportWorkerDb;
  signal?: AbortSignal;
  deps: AccountExportProcessDeps;
};

export const processAccountExport = async ({
  id,
  db,
  signal: parentSignal,
  deps,
}: ProcessAccountExportOptions): Promise<void> => {
  const claim = await deps.claim(id, db);
  // A ready replay, live lease, or terminal row has no new work to claim.
  if (claim === null) {
    return;
  }
  const outcome = await Result.tryPromise({
    try: async () => {
      const remainingMs = Math.min(
        ACCOUNT_EXPORT_ARCHIVE_LIMITS.buildMs,
        claim.leaseExpiresAt.getTime() -
          Temporal.Now.instant().epochMilliseconds,
      );
      if (remainingMs <= 0) {
        throw new AccountExportArchiveError({
          message: "Account export lease expired before build",
        });
      }
      const timeout = AbortSignal.timeout(remainingMs);
      const signal =
        parentSignal === undefined
          ? timeout
          : AbortSignal.any([timeout, parentSignal]);
      signal.throwIfAborted();
      await deps.build({
        db,
        userId: claim.userId,
        objectKey: claim.objectKey,
        signal,
      });
      signal.throwIfAborted();
      // A stale claim cannot publish its object over a newer winner.
      const completed = await deps.complete({
        claim,
        objectKey: claim.objectKey,
        db,
      });
      if (!completed) {
        await reclaimAccountExportAttempt({ claim, db, deps });
      }
    },
    catch: (cause) => cause,
  });
  if (Result.isOk(outcome)) {
    return;
  }
  deps.capture(outcome.error, { jobId: claim.id });
  const failed = await Result.tryPromise({
    try: async () => await deps.fail(claim, db),
    catch: (cause) => cause,
  });
  if (Result.isError(failed)) {
    deps.capture(failed.error, { jobId: claim.id });
  }
  const reclaimed = await Result.tryPromise({
    try: async () => await reclaimAccountExportAttempt({ claim, db, deps }),
    catch: (cause) => cause,
  });
  if (Result.isError(reclaimed)) {
    deps.capture(reclaimed.error, { jobId: claim.id });
  }
  // An ambiguous completion may have committed ready. Reclamation consults
  // the owning ledger and never removes its current processing/ready key.
  throw outcome.error;
};

type RecoverAccountExportOptions = {
  row: AccountExportRow;
  db: AccountExportDb;
  signal: AbortSignal;
};

const recoverAccountExport = async ({
  row,
  db,
  signal,
}: RecoverAccountExportOptions): Promise<void> => {
  switch (row.status) {
    case "requested":
    case "processing":
      await enqueueAccountExport(row.id);
      return;
    case "ready": {
      const expired = await expireAccountExport(row.id, db);
      if (expired !== null) {
        await cleanupAccountExport({ row: expired, db, signal });
      }
      return;
    }
    case "failed":
    case "expired":
      await cleanupAccountExport({ row, db, signal });
      return;
    default:
      row.status satisfies never;
      return panic("Unhandled account export status");
  }
};

const cleanupAccountExport = async ({
  row,
  db,
  signal,
}: RecoverAccountExportOptions): Promise<void> => {
  // Keep the durable keys until every bounded publication attempt has ended.
  if (!(await canReclaimAccountExportObjects(row.id, db))) {
    return;
  }
  const deleted = await deleteS3Keys(
    row.attemptObjectKeys,
    AbortSignal.any([signal, AbortSignal.timeout(STORAGE_CLEANUP_TIMEOUT_MS)]),
  );
  if (Result.isError(deleted)) {
    throw deleted.error;
  }
  await clearAccountExportObjects(row.id, db);
};

/** The composition root supplies the owning projections for every table. */
export const createAccountExportWorker =
  (projections: AccountExportProjections) =>
  ({ db }: BullMqWorkerContext) => {
    const deps = createProcessDeps(projections);
    const shutdown = new AbortController();
    const connection = createBullMqConnection({
      storeClass: "durable-coordination",
    });
    const worker = new BullMqWorker<AccountExportJob>(
      ACCOUNT_EXPORT_QUEUE_NAME,
      async ({ data }) =>
        await processAccountExport({
          id: data.id,
          db,
          signal: shutdown.signal,
          deps,
        }),
      { connection, concurrency: WORKER_CONCURRENCY },
    );
    worker.on("failed", (job, error) => {
      observeFailure(error, {
        sink: JOB_FAILED_SINK,
        ctx: {
          queue: ACCOUNT_EXPORT_QUEUE_NAME,
          ...(job === undefined ? {} : { jobId: job.data.id }),
        },
      });
    });
    worker.on(
      "error",
      createQueueWorkerErrorLogger("account_export.worker_error"),
    );

    let reconciling = false;
    let cursor: string | null = null;
    const reconcile = () => {
      if (reconciling || shutdown.signal.aborted) {
        return;
      }
      reconciling = true;
      const signal = AbortSignal.any([
        shutdown.signal,
        AbortSignal.timeout(RECONCILE_INTERVAL_MS),
      ]);
      // Re-read on every check: a tick ends at its deadline or on shutdown.
      const stopped = () => signal.aborted;
      detached(
        (async () => {
          try {
            const sweep = await Result.tryPromise({
              try: async () => {
                // Resume where the previous tick stopped; the first read after
                // a finished sweep starts from the beginning again.
                const resumeFrom = cursor;
                const pages = iterateCursorPages(
                  async (next) =>
                    await listRecoverableAccountExports(db, next ?? resumeFrom),
                );
                if (stopped()) {
                  return;
                }
                let pagesRead = 0;
                for await (const rows of pages) {
                  // A page past this tick's budget is left for the next tick,
                  // which resumes after the last recovered row.
                  if (pagesRead >= RECOVERY_PAGES_PER_TICK) {
                    return;
                  }
                  for (const row of rows) {
                    if (stopped()) {
                      return;
                    }
                    const recovered = await Result.tryPromise({
                      try: async () =>
                        // db-await-in-loop: rows recover one at a time so each row's state transition, storage cleanup, and failure stay isolated and the tick deadline is honoured between rows; a tick reads at most RECOVERY_PAGES_PER_TICK pages
                        await recoverAccountExport({ row, db, signal }),
                      catch: (cause) => cause,
                    });
                    if (Result.isError(recovered)) {
                      observeFailure(recovered.error, {
                        sink: RECOVERY_FAILED_SINK,
                        ctx: { jobId: row.id },
                      });
                    }
                    // Retain progress within a page when this tick's deadline
                    // ends; one slow row cannot pin recovery to the first page.
                    // After a page's last row this equals its next cursor.
                    cursor = encodePaginationCursor([row.id]);
                  }
                  pagesRead += 1;
                }
                cursor = null;
              },
              catch: (cause) => cause,
            });
            if (Result.isError(sweep)) {
              observeFailure(sweep.error, {
                sink: RECOVERY_FAILED_SINK,
                ctx: { queue: ACCOUNT_EXPORT_QUEUE_NAME },
              });
            }
          } finally {
            reconciling = false;
          }
        })(),
        "account-export.reconcile",
      );
    };
    reconcile();
    const interval = setInterval(reconcile, RECONCILE_INTERVAL_MS);
    return {
      queues: [ACCOUNT_EXPORT_QUEUE_NAME] as const,
      close: async () => {
        clearInterval(interval);
        shutdown.abort();
        await worker.close();
      },
    };
  };
