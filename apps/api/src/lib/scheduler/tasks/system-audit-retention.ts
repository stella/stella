import { sql } from "drizzle-orm";

import type { Temporal } from "@stll/time";
import { DAY_IN_MS } from "@stll/time";

import { systemAuditRuns } from "@/api/db/schema";
import type { SchedulerDb, SchedulerTask } from "@/api/lib/scheduler/types";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

export const PURGE_SYSTEM_AUDIT_RUNS_TASK = "audit.purgeSystemRuns" as const;

/** How long a system audit run is kept. */
export const SYSTEM_AUDIT_RETENTION_DAYS = 400;
export const SYSTEM_AUDIT_PURGE_BATCH_SIZE = 1000;
const MAX_PURGE_BATCHES_PER_RUN = 50;

/**
 * The oldest rows past `cutoff`, one bounded batch, along the created-at
 * index. No row lock: `FOR UPDATE` is held to the table's no-update policy, so
 * it would lock nothing, and two overlapping purges delete the same rows
 * harmlessly.
 */
export const systemAuditPurgeCandidatesQuery = (cutoff: Date) => sql`
  SELECT ${systemAuditRuns.id} FROM ${systemAuditRuns}
  WHERE ${systemAuditRuns.createdAt} < ${cutoff.toISOString()}::timestamptz
  ORDER BY ${systemAuditRuns.createdAt}
  LIMIT ${SYSTEM_AUDIT_PURGE_BATCH_SIZE}
`;

const purgeBatch = async (
  db: Pick<SchedulerDb, "execute">,
  cutoff: Date,
): Promise<number> => {
  const deleted = await db.execute(sql`
    DELETE FROM ${systemAuditRuns}
    WHERE ${systemAuditRuns.id} IN (${systemAuditPurgeCandidatesQuery(cutoff)})
    RETURNING ${systemAuditRuns.id}
  `);
  return deleted.length;
};

type PurgeOutcome = { deletedRuns: number; hasMore: boolean };

type PurgeProgress = {
  db: Pick<SchedulerDb, "execute">;
  cutoff: Date;
  signal: AbortSignal;
  batch: number;
  deletedSoFar: number;
};

const purgeFrom = async (progress: PurgeProgress): Promise<PurgeOutcome> => {
  const { db, cutoff, signal, batch, deletedSoFar } = progress;
  if (batch >= MAX_PURGE_BATCHES_PER_RUN || signal.aborted) {
    return { deletedRuns: deletedSoFar, hasMore: true };
  }
  const deleted = await purgeBatch(db, cutoff);
  if (deleted < SYSTEM_AUDIT_PURGE_BATCH_SIZE) {
    return { deletedRuns: deletedSoFar + deleted, hasMore: false };
  }
  return await purgeFrom({
    ...progress,
    batch: batch + 1,
    deletedSoFar: deletedSoFar + deleted,
  });
};

/**
 * Delete system audit runs older than the retention window in bounded
 * batches, and record the purge itself as a system run.
 */
export const purgeSystemAuditRuns = async ({
  db,
  now,
  signal,
}: {
  db: Pick<SchedulerDb, "execute">;
  now: Temporal.Instant;
  signal: AbortSignal;
}): Promise<PurgeOutcome> =>
  await purgeFrom({
    db,
    cutoff: new Date(
      now.epochMilliseconds - SYSTEM_AUDIT_RETENTION_DAYS * DAY_IN_MS,
    ),
    signal,
    batch: 0,
    deletedSoFar: 0,
  });

export const purgeSystemAuditRunsTask: SchedulerTask = async ({
  db,
  dueAt,
  runId,
  scheduleContinuation,
  signal,
}) => {
  signal.throwIfAborted();
  const { deletedRuns, hasMore } = await purgeSystemAuditRuns({
    db,
    now: dueAt.instant,
    signal,
  });
  await recordSystemAudit(db, "system:audit-retention", {
    subject: runId,
    counts: { deletedRuns },
  });
  if (hasMore && !signal.aborted) {
    // The claim instant is already past, so the continuation is due at once.
    scheduleContinuation(dueAt.claimedAtDate());
  }
};
