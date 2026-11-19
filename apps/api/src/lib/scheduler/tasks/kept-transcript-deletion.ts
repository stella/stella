import { asc, inArray, lte, sql } from "drizzle-orm";

import { mapWithConcurrency } from "@stll/concurrency";

import { keptTranscriptDeletions } from "@/api/db/schema";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
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

/** Rows one run takes: a minutely job deletes up to 72,000 a day, far
 *  beyond what the request's own deletes leave behind. */
const BATCH_SIZE = 50;
const PROVIDER_CONCURRENCY = 10;
/** Retries back off from one minute, doubling up to an hour. */
const MAX_BACKOFF_MINUTES = 60;
/** From this many failed attempts on, every further failure is reported. */
export const KEPT_TRANSCRIPT_REPORT_ATTEMPTS = 5;
/** A transcript still kept this long after it was recorded is reported. */
const KEPT_TRANSCRIPT_OVERDUE_MS = 60 * 60 * 1000;
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
 * Reads the due rows, unlocked. The scheduler runs this job on one replica
 * at a time, and a provider delete is idempotent (a transcript already gone
 * counts as deleted), so a row the request's own delete settles meanwhile,
 * or one a run that died left behind, is simply tried again. Attempts count
 * only settled outcomes.
 */
const readDueTranscripts = async (db: SchedulerTaskContext["db"]) =>
  await withAggregateTransaction(
    db,
    async (tx) =>
      await tx
        .select({
          transcriptionId: keptTranscriptDeletions.transcriptionId,
          environment: keptTranscriptDeletions.environment,
          attempts: keptTranscriptDeletions.attempts,
        })
        .from(keptTranscriptDeletions)
        .where(lte(keptTranscriptDeletions.nextAttemptAt, sql`now()`))
        .orderBy(asc(keptTranscriptDeletions.nextAttemptAt))
        .limit(BATCH_SIZE),
  );

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
          // The exponent stops at 6 (64 minutes, held to the hour) so a row
          // refused for weeks never overflows the power.
          nextAttemptAt: sql`now() + interval '1 minute' * LEAST(power(2, LEAST(${keptTranscriptDeletions.attempts}, 6)), ${MAX_BACKOFF_MINUTES})`,
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

/** Deletes one batch of due transcripts at the provider and settles it. */
const deleteDueBatch = async (
  { db, logger, signal }: SchedulerTaskContext,
  deployment: ElevenLabsDeployment,
  dependencies: KeptTranscriptDeletionDependencies,
) => {
  const due = await readDueTranscripts(db);
  if (due.length === 0 || signal.aborted) {
    return;
  }
  const outcomes = await mapWithConcurrency({
    items: due,
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
  const overdue = await withAggregateTransaction(
    db,
    async (tx) =>
      await readBounded(
        tx
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
      ),
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
