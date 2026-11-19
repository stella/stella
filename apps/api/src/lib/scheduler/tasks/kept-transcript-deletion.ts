import { asc, inArray, lte, sql } from "drizzle-orm";

import { mapWithConcurrency } from "@stll/concurrency";

import { keptTranscriptDeletions } from "@/api/db/schema";
import {
  withAggregateTransaction,
  withSkipLockedBatch,
} from "@/api/lib/db/aggregate-lock";
import { readBounded } from "@/api/lib/db/read-bounded";
import {
  elevenLabsKeepsTranscripts,
  readElevenLabsDeployment,
} from "@/api/lib/dictation/elevenlabs-deployment";
import type { ElevenLabsDeployment } from "@/api/lib/dictation/elevenlabs-deployment";
import { deleteKeptTranscriptAt } from "@/api/lib/dictation/kept-transcript-delete";
import type {
  SchedulerTask,
  SchedulerTaskContext,
} from "@/api/lib/scheduler/types";
import { sqlCaseFragment } from "@/api/lib/sql-case-expression";

export const DELETE_KEPT_TRANSCRIPTS_TASK =
  "dictation.deleteKeptTranscripts" as const;

/** Rows one run claims: a minutely job deletes up to 72,000 a day, far
 *  beyond what the request's own deletes leave behind. */
const BATCH_SIZE = 50;
const PROVIDER_CONCURRENCY = 10;
/** A claimed row waits this long before another run may try it, so a run
 *  that dies mid-batch leaves it retryable. */
const CLAIM_LEASE_MS = 10 * 60 * 1000;
/** Retries back off from one minute, doubling up to an hour. */
const MAX_BACKOFF_MINUTES = 60;
/** From this many failed attempts on, every further failure is reported. */
export const KEPT_TRANSCRIPT_REPORT_ATTEMPTS = 5;
/** A transcript still kept this long after it was recorded is reported. */
export const KEPT_TRANSCRIPT_OVERDUE_MS = 60 * 60 * 1000;
const OVERDUE_REPORT_CAP = 100;
const OVERDUE_REPORT_IDS = 10;

export const KEPT_TRANSCRIPT_EVENTS = {
  deleteFailing: "dictation.kept_transcript.delete_failing",
  overdue: "dictation.kept_transcript.overdue",
} as const;

type KeptTranscriptDeletionDependencies = {
  deployment: ElevenLabsDeployment | null;
  deleteTranscript: typeof deleteKeptTranscriptAt;
};

const productionDependencies = (): KeptTranscriptDeletionDependencies => ({
  deployment: readElevenLabsDeployment(),
  deleteTranscript: deleteKeptTranscriptAt,
});

/**
 * Leases due rows: the lease commits with the row locks, and attempts count
 * only settled outcomes, so an interrupted run leaves its rows retryable
 * once the lease lapses.
 */
const claimDueTranscripts = async (db: SchedulerTaskContext["db"]) =>
  await withSkipLockedBatch({
    database: db,
    limit: BATCH_SIZE,
    select: (tx) =>
      tx
        .select({ transcriptionId: keptTranscriptDeletions.transcriptionId })
        .from(keptTranscriptDeletions)
        .where(lte(keptTranscriptDeletions.nextAttemptAt, sql`now()`))
        .$dynamic(),
    run: async (tx, rows) => {
      if (rows.length === 0) {
        return [];
      }
      // audit: skip - Leases provider ids queued for deletion; no member data changes.
      return await tx
        .update(keptTranscriptDeletions)
        .set({
          nextAttemptAt: sql`now() + (${CLAIM_LEASE_MS} * interval '1 millisecond')`,
        })
        .where(
          inArray(
            keptTranscriptDeletions.transcriptionId,
            rows.map(({ transcriptionId }) => transcriptionId),
          ),
        )
        .returning({
          transcriptionId: keptTranscriptDeletions.transcriptionId,
          environment: keptTranscriptDeletions.environment,
          attempts: keptTranscriptDeletions.attempts,
        });
    },
  });

type Failure = { transcriptionId: string; attempts: number; code: string };

const settleOutcomes = async (
  db: SchedulerTaskContext["db"],
  deletedIds: readonly string[],
  failures: readonly Failure[],
) => {
  if (deletedIds.length === 0 && failures.length === 0) {
    return;
  }
  await withAggregateTransaction(db, async (tx) => {
    if (deletedIds.length > 0) {
      // audit: skip - The provider confirmed these deletes; the queued ids have no further use.
      await tx
        .delete(keptTranscriptDeletions)
        .where(inArray(keptTranscriptDeletions.transcriptionId, deletedIds));
    }
    if (failures.length > 0) {
      // One statement for the batch: each row keeps its own error code and
      // backs off from its own attempt count.
      // audit: skip - Records a provider refusal on a queued id; no member data changes.
      await tx
        .update(keptTranscriptDeletions)
        .set({
          attempts: sql`${keptTranscriptDeletions.attempts} + 1`,
          lastErrorCode: sqlCaseFragment({
            operand: sql`${keptTranscriptDeletions.transcriptionId}`,
            branches: failures.map(
              ({ transcriptionId, code }) =>
                sql`WHEN ${transcriptionId} THEN ${code}`,
            ),
            fallback: sql`${keptTranscriptDeletions.lastErrorCode}`,
          }),
          nextAttemptAt: sql`now() + interval '1 minute' * LEAST(power(2, ${keptTranscriptDeletions.attempts}), ${MAX_BACKOFF_MINUTES})`,
        })
        .where(
          inArray(
            keptTranscriptDeletions.transcriptionId,
            failures.map(({ transcriptionId }) => transcriptionId),
          ),
        );
    }
  });
};

/** Deletes one claimed batch at the provider and settles it. */
const deleteDueBatch = async (
  { db, logger, signal }: SchedulerTaskContext,
  deployment: ElevenLabsDeployment,
  dependencies: KeptTranscriptDeletionDependencies,
) => {
  const claimed = await claimDueTranscripts(db);
  if (claimed.length === 0 || signal.aborted) {
    return;
  }
  const outcomes = await mapWithConcurrency({
    items: claimed,
    limit: PROVIDER_CONCURRENCY,
    operation: async (row) => ({
      row,
      outcome: await dependencies.deleteTranscript({
        deployment,
        environment: row.environment,
        transcriptionId: row.transcriptionId,
      }),
    }),
  });
  const deletedIds: string[] = [];
  const failures: Failure[] = [];
  for (const { row, outcome } of outcomes) {
    if (outcome.type === "deleted") {
      deletedIds.push(row.transcriptionId);
    } else {
      failures.push({
        transcriptionId: row.transcriptionId,
        attempts: row.attempts + 1,
        code: outcome.code,
      });
    }
  }
  await settleOutcomes(db, deletedIds, failures);
  for (const failure of failures) {
    if (failure.attempts >= KEPT_TRANSCRIPT_REPORT_ATTEMPTS) {
      logger.error(KEPT_TRANSCRIPT_EVENTS.deleteFailing, {
        "keptTranscript.id": failure.transcriptionId,
        "keptTranscript.attempts": failure.attempts,
        "keptTranscript.lastErrorCode": failure.code,
      });
    }
  }
  if (deletedIds.length > 0 || failures.length > 0) {
    logger.info("scheduler.kept_transcripts_settled", {
      "keptTranscript.deleted": deletedIds.length,
      "keptTranscript.failed": failures.length,
    });
  }
};

/** Reports every transcript still kept past the bound, oldest first. */
const reportOverdue = async ({ db, logger }: SchedulerTaskContext) => {
  const overdue = await readBounded(
    db
      .select({
        transcriptionId: keptTranscriptDeletions.transcriptionId,
        createdAt: keptTranscriptDeletions.createdAt,
      })
      .from(keptTranscriptDeletions)
      .where(
        sql`${keptTranscriptDeletions.createdAt} < now() - (${KEPT_TRANSCRIPT_OVERDUE_MS} * interval '1 millisecond')`,
      )
      .orderBy(asc(keptTranscriptDeletions.createdAt)),
    OVERDUE_REPORT_CAP,
  );
  if (overdue.type === "overflow") {
    logger.error(KEPT_TRANSCRIPT_EVENTS.overdue, {
      "keptTranscript.overdue": `more than ${overdue.cap}`,
    });
    return;
  }
  const [oldest] = overdue.rows;
  if (oldest === undefined) {
    return;
  }
  logger.error(KEPT_TRANSCRIPT_EVENTS.overdue, {
    "keptTranscript.overdue": String(overdue.rows.length),
    "keptTranscript.oldestRecordedAt": oldest.createdAt.toISOString(),
    "keptTranscript.ids": overdue.rows
      .slice(0, OVERDUE_REPORT_IDS)
      .map(({ transcriptionId }) => transcriptionId)
      .join(","),
  });
};

/**
 * Deletes the transcripts ElevenLabs kept for dictation made without zero
 * retention that the request's own delete did not settle: a refused or
 * failed delete, or a process that stopped before it ran. Retries back off
 * up to an hour and never give up. A transcript that keeps failing, or that
 * is still kept an hour after it was recorded, is reported at error level
 * on every run until it is gone.
 */
export const runKeptTranscriptDeletions = async (
  context: SchedulerTaskContext,
  dependencies: KeptTranscriptDeletionDependencies = productionDependencies(),
): Promise<void> => {
  const { deployment } = dependencies;
  if (!elevenLabsKeepsTranscripts(deployment)) {
    return;
  }
  await deleteDueBatch(context, deployment, dependencies);
  await reportOverdue(context);
};

export const deleteKeptTranscripts: SchedulerTask = async (context) => {
  await runKeptTranscriptDeletions(context);
};
