/**
 * Moves a withdrawal's reason out of `error_message` and into `detail` on the
 * index-job trail.
 *
 * The column split landed as DDL; the rows written before it still hold their
 * reason in the failure column. Neither table has an index on `operation`, so
 * the repair cannot be a single statement over the whole trail: it walks the
 * primary key in bounded pages, each page one short statement, and checkpoints
 * the cursor so a lost run resumes where it stopped. It retires itself once
 * both tables are walked.
 */

import { panic, Result, TaggedError } from "better-result";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { rootDb } from "@/api/db/root";
import {
  CORPUS_INDEX_JOB_SUCCEEDED_CHECKS,
  caseLawIndexJobs,
  legislationIndexJobs,
  schedulerJobs,
} from "@/api/db/schema";
import { isUuid } from "@/api/lib/custom-schema";
import type { CorpusIndexProjectionSubject } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";
import type {
  SchedulerTask,
  SchedulerTaskContext,
} from "@/api/lib/scheduler/types";
import { isRecord } from "@/api/lib/type-guards";

export const BACKFILL_CORPUS_INDEX_JOB_DETAIL_TASK =
  "corpusIndex.backfillJobDetail" as const;

/**
 * One page of primary keys per statement. Large enough that a whole trail is
 * walked in a bounded number of runs, small enough that the page read and the
 * update it drives stay short.
 */
const BACKFILL_LIMIT = 1000;

/** A page that found work leaves more behind it; the next one follows at once. */
const CONTINUATION_DELAY_MS = 1000;

/**
 * Budgets LOCAL to a page's transaction. A page reads and writes a bounded
 * set of rows by primary key, so it owes nothing to a lock it cannot get at
 * once: without these a row held by a writer would keep the task, and the
 * connection under it, past the scheduler lease that says it is still running.
 */
const BATCH_LOCK_TIMEOUT = "5s";
const BATCH_STATEMENT_TIMEOUT = "30s";
/**
 * VALIDATE takes SHARE UPDATE EXCLUSIVE, which lets writers through but queues
 * behind an autovacuum of the table until that vacuum yields, so the wait is
 * longer than a page's. Its scan reads the trail once, which is far more than a
 * page does and still finite: the budget is sized for that scan rather than
 * lifted, so a validation that is not making progress is cancelled and tried
 * again on the next tick instead of holding its connection indefinitely.
 */
const VALIDATE_LOCK_TIMEOUT = "1min";
const VALIDATE_STATEMENT_TIMEOUT = "30min";

type TransactionBudget = { lockTimeout: string; statementTimeout: string };

/**
 * Both budgets, set LOCAL so they end with the transaction. Written as raw
 * statements because `SET LOCAL` takes a literal, not a bind parameter; the
 * values are this module's own constants.
 */
const setTransactionBudget = async (
  tx: Transaction,
  { lockTimeout, statementTimeout }: TransactionBudget,
): Promise<void> => {
  await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${lockTimeout}'`));
  await tx.execute(
    sql.raw(`SET LOCAL statement_timeout = '${statementTimeout}'`),
  );
};

export type CorpusIndexJobDetailBatch = {
  movedCount: number;
  /** The last key the page read; null when the table is walked to its end. */
  nextCursor: string | null;
};

type CorpusIndexJobDetailBatchOptions = {
  cursor: string | null;
  limit: number;
};

const caseLawDetailBatch = async (
  tx: Transaction,
  { cursor, limit }: CorpusIndexJobDetailBatchOptions,
): Promise<CorpusIndexJobDetailBatch> => {
  const page = await tx
    .select({ id: caseLawIndexJobs.id })
    .from(caseLawIndexJobs)
    .where(
      cursor === null ? undefined : sql`${caseLawIndexJobs.id} > ${cursor}`,
    )
    .orderBy(asc(caseLawIndexJobs.id))
    .limit(limit);
  const lastId = page.at(-1)?.id;
  if (lastId === undefined) {
    return { movedCount: 0, nextCursor: null };
  }
  const moved = await tx
    .update(caseLawIndexJobs)
    // The SET list reads the row as it was, so the reason lands in `detail`
    // before the column it came from is cleared.
    .set({ detail: sql`${caseLawIndexJobs.errorMessage}`, errorMessage: null })
    .where(
      and(
        inArray(
          caseLawIndexJobs.id,
          page.map(({ id }) => id),
        ),
        eq(caseLawIndexJobs.operation, "withdraw"),
        eq(caseLawIndexJobs.status, "succeeded"),
        isNotNull(caseLawIndexJobs.errorMessage),
      ),
    )
    .returning({ id: caseLawIndexJobs.id });
  return { movedCount: moved.length, nextCursor: lastId };
};

const legislationDetailBatch = async (
  tx: Transaction,
  { cursor, limit }: CorpusIndexJobDetailBatchOptions,
): Promise<CorpusIndexJobDetailBatch> => {
  const page = await tx
    .select({ id: legislationIndexJobs.id })
    .from(legislationIndexJobs)
    .where(
      cursor === null ? undefined : sql`${legislationIndexJobs.id} > ${cursor}`,
    )
    .orderBy(asc(legislationIndexJobs.id))
    .limit(limit);
  const lastId = page.at(-1)?.id;
  if (lastId === undefined) {
    return { movedCount: 0, nextCursor: null };
  }
  const moved = await tx
    .update(legislationIndexJobs)
    .set({
      detail: sql`${legislationIndexJobs.errorMessage}`,
      errorMessage: null,
    })
    .where(
      and(
        inArray(
          legislationIndexJobs.id,
          page.map(({ id }) => id),
        ),
        eq(legislationIndexJobs.operation, "withdraw"),
        eq(legislationIndexJobs.status, "succeeded"),
        isNotNull(legislationIndexJobs.errorMessage),
      ),
    )
    .returning({ id: legislationIndexJobs.id });
  return { movedCount: moved.length, nextCursor: lastId };
};

/**
 * The families in the order the sweep walks them. Total over the corpus
 * families, so a third family cannot be added without a decision here.
 */
const CORPUS_INDEX_JOB_DETAIL_BATCHES = {
  case_law: caseLawDetailBatch,
  legislation: legislationDetailBatch,
} as const satisfies Record<
  CorpusIndexProjectionSubject["family"],
  (
    tx: Transaction,
    options: CorpusIndexJobDetailBatchOptions,
  ) => Promise<CorpusIndexJobDetailBatch>
>;

export type CorpusIndexJobDetailFamily =
  keyof typeof CORPUS_INDEX_JOB_DETAIL_BATCHES;

const FAMILY_ORDER = [
  "case_law",
  "legislation",
] as const satisfies readonly CorpusIndexJobDetailFamily[];

type CorpusIndexJobDetailRunOptions = {
  family: CorpusIndexJobDetailFamily;
  cursor: string | null;
  limit?: number;
};

/** One bounded page of the named family's trail. */
export const runCorpusIndexJobDetailBatchTx = async (
  tx: Transaction,
  { family, cursor, limit = BACKFILL_LIMIT }: CorpusIndexJobDetailRunOptions,
): Promise<CorpusIndexJobDetailBatch> =>
  await CORPUS_INDEX_JOB_DETAIL_BATCHES[family](tx, { cursor, limit });

const CONSTRAINT_STATE_QUERY = (table: string, constraint: string) => sql`
  SELECT constraint_state.convalidated AS "isValidated"
  FROM pg_catalog.pg_constraint constraint_state
  JOIN pg_catalog.pg_class table_relation
    ON table_relation.oid = constraint_state.conrelid
  JOIN pg_catalog.pg_namespace table_namespace
    ON table_namespace.oid = table_relation.relnamespace
  WHERE table_namespace.nspname = 'public'
    AND table_relation.relname = ${table}
    AND constraint_state.conname = ${constraint}
`;

/** `execute` answers with an array on one driver and `{ rows }` on the other. */
const executedRows = (result: unknown): Record<string, unknown>[] => {
  if (Array.isArray(result)) {
    return result.filter((row: unknown) => isRecord(row));
  }
  return isRecord(result) && Array.isArray(result["rows"])
    ? result["rows"].filter((row: unknown) => isRecord(row))
    : [];
};

type IndexJobTable = keyof typeof CORPUS_INDEX_JOB_SUCCEEDED_CHECKS;

/**
 * One trail's check, read back from the catalog rather than assumed: a
 * validation that did not take must leave the repair unfinished.
 */
const validateCheck = async (
  tx: Transaction,
  table: IndexJobTable,
): Promise<void> => {
  const constraint = CORPUS_INDEX_JOB_SUCCEEDED_CHECKS[table];
  await tx.execute(
    sql.raw(
      `ALTER TABLE public."${table}" VALIDATE CONSTRAINT "${constraint}"`,
    ),
  );
  const state = executedRows(
    await tx.execute(CONSTRAINT_STATE_QUERY(table, constraint)),
  ).at(0);
  if (state?.["isValidated"] !== true) {
    panic(`Constraint ${constraint} on ${table} is not validated`);
  }
};

/**
 * Check both trails against the rows that predate their constraints.
 *
 * The migration added each check NOT VALID, so PostgreSQL enforces it on every
 * write but has never read the rows already there; until it does,
 * `pg_constraint.convalidated` stays false and the invariant holds only for
 * what the new writers wrote. Validating is the last step of the repair and a
 * no-op once done, which is what makes running it again harmless.
 */
export const validateCorpusIndexJobChecksTx = async (
  tx: Transaction,
): Promise<void> => {
  // Both trails, named rather than iterated: DDL cannot be batched, and each
  // statement waits on its own table's lock.
  await validateCheck(tx, "case_law_index_jobs");
  await validateCheck(tx, "legislation_index_jobs");
};

class CorpusIndexJobDetailBackfillError extends TaggedError(
  "CorpusIndexJobDetailBackfillError",
)<{ message: string; cause?: unknown }> {}

/** The two steps a run takes, which give up on different terms. */
export type BackfillStep = "page" | "validate";

/**
 * What a step may lose to and still be tried again, by step.
 *
 * A page is refused a lock or it commits, and its statement budget is sized
 * for a bounded write: a page cancelled by that budget is a page that is not
 * doing what it says, which the runner should record. A validation gives up on
 * both terms — the lock it waits for and the scan it runs — and neither leaves
 * anything behind, so the next tick simply asks again.
 */
const BACKFILL_RETRY_CODES = {
  page: [PG_ERROR.LOCK_NOT_AVAILABLE],
  validate: [PG_ERROR.LOCK_NOT_AVAILABLE, PG_ERROR.QUERY_CANCELED],
} as const satisfies Record<BackfillStep, readonly string[]>;

/** True when the step gave up without committing, so running it again converges. */
export const isRetriableBackfillFailure = (
  failure: unknown,
  step: BackfillStep,
): boolean =>
  BACKFILL_RETRY_CODES[step].some((code) => isPgError(failure, code));

type BackfillFailureReport = {
  event: string;
  family: CorpusIndexJobDetailFamily;
  logger: SchedulerTaskContext["logger"];
  step: BackfillStep;
};

/**
 * What a step that did not commit means for the sweep.
 *
 * A step that gave up on its own budget is not a failure: it moved nothing and
 * checkpointed nothing, so the next tick asks for the same range again and the
 * repair still converges. Anything else is the runner's to record, and a
 * scheduler task reports that through the promise it returns, the way a
 * readiness probe does.
 */
const reportBackfillFailure = async (
  failure: CorpusIndexJobDetailBackfillError,
  { event, family, logger, step }: BackfillFailureReport,
): Promise<void> => {
  if (!isRetriableBackfillFailure(failure, step)) {
    await Promise.reject(failure);
    return;
  }
  logger.info(event, { "corpusIndexJobDetail.family": family });
};

type BackfillPosition = {
  family: CorpusIndexJobDetailFamily;
  cursor: string | null;
};

const isDetailFamily = (value: unknown): value is CorpusIndexJobDetailFamily =>
  typeof value === "string" && value in CORPUS_INDEX_JOB_DETAIL_BATCHES;

/** Where the last run stopped; an absent payload starts the first family. */
const parsePosition = (
  payload: Record<string, unknown> | null,
): BackfillPosition => {
  const family = payload?.["family"] ?? FAMILY_ORDER[0];
  const cursor = payload?.["cursor"] ?? null;
  if (!isDetailFamily(family)) {
    return panic(
      "Corpus index-job detail backfill family is not a corpus family",
    );
  }
  if (cursor !== null && (typeof cursor !== "string" || !isUuid(cursor))) {
    return panic("Corpus index-job detail backfill cursor must be a UUID");
  }
  return { cursor, family };
};

/** The family after this one, or null when the sweep has walked them all. */
const nextFamily = (
  family: CorpusIndexJobDetailFamily,
): CorpusIndexJobDetailFamily | null =>
  FAMILY_ORDER[FAMILY_ORDER.indexOf(family) + 1] ?? null;

export const backfillCorpusIndexJobDetail: SchedulerTask = async ({
  job,
  logger,
  scheduleContinuation,
  signal,
}) => {
  signal.throwIfAborted();
  const { cursor, family } = parsePosition(job.payload);
  const leaseToken =
    job.lockedBy ??
    panic("Corpus index-job detail backfill requires a scheduler lease");
  const leaseFence = and(
    eq(schedulerJobs.id, job.id),
    eq(schedulerJobs.lockedBy, leaseToken),
  );

  const page = await Result.tryPromise({
    try: async () =>
      await rootDb.transaction(async (tx) => {
        await setTransactionBudget(tx, {
          lockTimeout: BATCH_LOCK_TIMEOUT,
          statementTimeout: BATCH_STATEMENT_TIMEOUT,
        });
        const { movedCount, nextCursor } = await runCorpusIndexJobDetailBatchTx(
          tx,
          { cursor, family },
        );
        if (nextCursor !== null) {
          // Checkpoint last: replaying a page moves nothing a second time,
          // while advancing first could step over rows the update did not
          // reach.
          await tx
            .update(schedulerJobs)
            .set({ payload: { cursor: nextCursor, family } })
            .where(leaseFence);
          return { family, movedCount, status: "progress" as const };
        }

        const following = nextFamily(family);
        if (following === null) {
          return { family, movedCount, status: "swept" as const };
        }
        await tx
          .update(schedulerJobs)
          .set({ payload: { cursor: null, family: following } })
          .where(leaseFence);
        return { family, movedCount, status: "progress" as const };
      }),
    catch: (cause) =>
      new CorpusIndexJobDetailBackfillError({
        message: "A corpus index-job detail page did not commit",
        cause,
      }),
  });
  if (Result.isError(page)) {
    return await reportBackfillFailure(page.error, {
      event: "scheduler.corpus_index_job_detail_contended",
      family,
      logger,
      step: "page",
    });
  }

  logger.info("scheduler.corpus_index_job_detail_backfilled", {
    "corpusIndexJobDetail.family": page.value.family,
    "corpusIndexJobDetail.moved": page.value.movedCount,
    "corpusIndexJobDetail.status": page.value.status,
  });

  if (page.value.status === "progress") {
    if (!signal.aborted) {
      scheduleContinuation(new Date(Date.now() + CONTINUATION_DELAY_MS));
    }
    return;
  }

  // Both trails are walked, so no row can hold the old shape any more and the
  // constraints the migration left NOT VALID can be checked against the rows
  // that predate them. The job retires in the same transaction: a validation
  // that does not finish leaves the job enabled, and the next tick, finding
  // nothing left to move, tries again.
  const validated = await Result.tryPromise({
    try: async () =>
      await rootDb.transaction(async (tx) => {
        await setTransactionBudget(tx, {
          lockTimeout: VALIDATE_LOCK_TIMEOUT,
          statementTimeout: VALIDATE_STATEMENT_TIMEOUT,
        });
        await validateCorpusIndexJobChecksTx(tx);
        // audit: skip — retires a versioned one-shot repair; scheduler job
        // runs retain the operator trail.
        await tx
          .update(schedulerJobs)
          .set({ enabled: false })
          .where(leaseFence);
      }),
    catch: (cause) =>
      new CorpusIndexJobDetailBackfillError({
        message: "The corpus index-job checks were not validated",
        cause,
      }),
  });
  if (Result.isError(validated)) {
    return await reportBackfillFailure(validated.error, {
      event: "scheduler.corpus_index_job_detail_validation_contended",
      family,
      logger,
      step: "validate",
    });
  }

  logger.info("scheduler.corpus_index_job_detail_validated", {});
};
