import { Result } from "better-result";
import { inArray, lte, sql } from "drizzle-orm";

import { mapWithConcurrency } from "@stll/concurrency";

import { agentSkillOriginalCleanupRequests } from "@/api/db/schema";
import {
  withAggregateTransaction,
  withSkipLockedBatch,
} from "@/api/lib/db/aggregate-lock";
import { deleteS3Keys } from "@/api/lib/files/utils";
import type {
  SchedulerTask,
  SchedulerTaskContext,
} from "@/api/lib/scheduler/types";
import { sqlCaseFragment } from "@/api/lib/sql-case-expression";

export const CLEAN_AGENT_SKILL_ORIGINAL_OBJECTS_TASK =
  "agentSkills.cleanOriginalObjects" as const;

/** Requests one run takes; each holds the keys one deleting statement freed. */
const BATCH_SIZE = 32;
const DELETE_CONCURRENCY = 4;
/** Retries back off from one minute, doubling up to a day. */
const MAX_BACKOFF_MINUTES = 24 * 60;
/** From this many failed attempts on, every further failure is reported. */
const REPORT_ATTEMPTS = 5;
/** Longest error text kept on a request. */
const ERROR_MAX_CHARS = 500;

type CleanupRequest = {
  attempts: number;
  id: (typeof agentSkillOriginalCleanupRequests.$inferSelect)["id"];
  s3Keys: string[];
};

type Failure = { id: CleanupRequest["id"]; attempts: number; error: string };

/** Deletes one request's keys; `deleteS3Keys` in production. */
type DeleteKeys = (
  keys: string[],
  signal?: AbortSignal,
) => Promise<Result<void, Error>>;

/**
 * Takes the due requests. The scheduler runs this job on one replica at a
 * time and deleting an object is idempotent (one already gone counts as
 * deleted), so the row locks last only for the read: a request a run that
 * stopped left behind is simply tried again.
 */
const readDueRequests = async (db: SchedulerTaskContext["db"]) =>
  await withSkipLockedBatch({
    database: db,
    limit: BATCH_SIZE,
    select: (tx) =>
      tx
        .select({
          attempts: agentSkillOriginalCleanupRequests.attempts,
          id: agentSkillOriginalCleanupRequests.id,
          s3Keys: agentSkillOriginalCleanupRequests.s3Keys,
        })
        .from(agentSkillOriginalCleanupRequests)
        .where(lte(agentSkillOriginalCleanupRequests.nextAttemptAt, sql`now()`))
        .$dynamic(),
    run: async (_tx, rows) => await Promise.resolve(rows),
  });

const settleOutcomes = async (
  db: SchedulerTaskContext["db"],
  erasedIds: readonly CleanupRequest["id"][],
  failures: readonly Failure[],
) => {
  if (erasedIds.length === 0 && failures.length === 0) {
    return;
  }
  const table = agentSkillOriginalCleanupRequests;
  await withAggregateTransaction(db, async (tx) => {
    if (erasedIds.length > 0) {
      // audit: skip - The objects are erased; the queued keys have no further use.
      await tx.delete(table).where(inArray(table.id, erasedIds));
    }
    if (failures.length > 0) {
      // audit: skip - Records a storage failure on a queued erasure; no member data changes.
      await tx
        .update(table)
        .set({
          attempts: sql`${table.attempts} + 1`,
          lastError: sqlCaseFragment({
            operand: sql`${table.id}`,
            branches: failures.map(
              ({ id, error }) => sql`WHEN ${id}::uuid THEN ${error}`,
            ),
            fallback: sql`${table.lastError}`,
          }),
          // The exponent stops at 11 (2048 minutes, held to a day) so a
          // request refused for weeks never overflows the power.
          nextAttemptAt: sql`now() + interval '1 minute' * LEAST(power(2, LEAST(${table.attempts}, 11)), ${MAX_BACKOFF_MINUTES})`,
        })
        .where(
          inArray(
            table.id,
            failures.map(({ id }) => id),
          ),
        );
    }
  });
};

/** Why a deletion failed, whether it threw or answered an error; else null. */
const deletionError = (
  deleted: Result<Awaited<ReturnType<DeleteKeys>>, Error>,
): Error | null => {
  if (Result.isError(deleted)) {
    return deleted.error;
  }
  return Result.isError(deleted.value) ? deleted.value.error : null;
};

/**
 * Erase the skill file originals the row triggers queued: each request's
 * keys are deleted, which also settles their storage accounting, and the
 * request removed; a failure backs off and is retried. `deleteKeys` is
 * injected by tests.
 */
export const createCleanAgentSkillOriginalObjects =
  (deleteKeys: DeleteKeys = deleteS3Keys): SchedulerTask =>
  async ({ db, logger, signal }) => {
    if (signal.aborted) {
      return;
    }
    const due = await readDueRequests(db);
    if (due.length === 0) {
      return;
    }
    const outcomes = await mapWithConcurrency({
      items: due,
      limit: DELETE_CONCURRENCY,
      operation: async (request: CleanupRequest) => ({
        request,
        deleted: await Result.tryPromise(
          async () => await deleteKeys(request.s3Keys, signal),
        ),
      }),
    });
    const erasedIds: CleanupRequest["id"][] = [];
    const failures: Failure[] = [];
    for (const { request, deleted } of outcomes) {
      const error = deletionError(deleted);
      if (error === null) {
        erasedIds.push(request.id);
      } else {
        failures.push({
          attempts: request.attempts + 1,
          error: error.message.slice(0, ERROR_MAX_CHARS),
          id: request.id,
        });
      }
    }
    await settleOutcomes(db, erasedIds, failures);
    for (const failure of failures) {
      if (failure.attempts >= REPORT_ATTEMPTS) {
        logger.error("agent_skills.original_cleanup_failing", {
          "agentSkillOriginalCleanup.id": failure.id,
          "agentSkillOriginalCleanup.attempts": failure.attempts,
        });
      }
    }
    logger.info("agent_skills.original_cleanup_settled", {
      "agentSkillOriginalCleanup.erased": erasedIds.length,
      "agentSkillOriginalCleanup.failed": failures.length,
    });
  };

export const cleanAgentSkillOriginalObjects =
  createCleanAgentSkillOriginalObjects();
