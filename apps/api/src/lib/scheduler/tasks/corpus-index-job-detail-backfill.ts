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

import { panic } from "better-result";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { rootDb } from "@/api/db/root";
import {
  caseLawIndexJobs,
  legislationIndexJobs,
  schedulerJobs,
} from "@/api/db/schema";
import { isUuid } from "@/api/lib/custom-schema";
import type { CorpusIndexProjectionSubject } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

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

  const outcome = await rootDb.transaction(async (tx) => {
    const { movedCount, nextCursor } = await runCorpusIndexJobDetailBatchTx(
      tx,
      {
        cursor,
        family,
      },
    );
    if (nextCursor !== null) {
      // Checkpoint last: replaying a page moves nothing a second time, while
      // advancing first could step over rows the update did not reach.
      await tx
        .update(schedulerJobs)
        .set({ payload: { cursor: nextCursor, family } })
        .where(leaseFence);
      return { family, movedCount, status: "progress" as const };
    }

    const following = nextFamily(family);
    if (following !== null) {
      await tx
        .update(schedulerJobs)
        .set({ payload: { cursor: null, family: following } })
        .where(leaseFence);
      return { family, movedCount, status: "progress" as const };
    }

    // audit: skip — retires a versioned one-shot repair; scheduler job runs
    // retain the operator trail.
    await tx.update(schedulerJobs).set({ enabled: false }).where(leaseFence);
    return { family, movedCount, status: "complete" as const };
  });

  logger.info("scheduler.corpus_index_job_detail_backfilled", {
    "corpusIndexJobDetail.family": outcome.family,
    "corpusIndexJobDetail.moved": outcome.movedCount,
    "corpusIndexJobDetail.status": outcome.status,
  });

  if (outcome.status === "progress" && !signal.aborted) {
    scheduleContinuation(new Date(Date.now() + CONTINUATION_DELAY_MS));
  }
};
