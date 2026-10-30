/**
 * Scheduled jobs around the schema migration phase.
 *
 * The migrate task runs the new release's code while the previous release's
 * scheduler keeps running. A scheduled job inside a long read transaction
 * holds a lock that refuses the schema phase's `ACCESS EXCLUSIVE` DDL, and the
 * lock-wait ladder cannot outlast it. The scheduler already honours
 * `scheduler_jobs.paused_until`: it skips a leased run that has not started
 * and stops a running one at its next heartbeat. This module uses that pause
 * to drain the jobs before the pending schema migrations and to resume them
 * afterwards.
 *
 * No job-to-table map exists, and a hand-listed subset would drift, so every
 * job is paused except those an operator already paused (left untouched) and
 * the pause audit (the database forbids pausing it). The pause carries a
 * deadline, so a migrate task that dies leaves no job paused for long.
 *
 * Relative imports only: `migrate.ts` ships as a loose file.
 */

import { Result, TaggedError } from "better-result";
import type { ReservedSQL } from "bun";

import { declareFingerprintFields } from "@stll/errors";

import type { MigrationTiming } from "./migration-timing";

/** `paused_by` of every pause this step writes; resumes match on it. */
export const SCHEDULER_DRAIN_ACTOR = "migrate";
/** The one job the database refuses to pause. */
export const UNPAUSABLE_SCHEDULER_JOB_ID = "scheduler.pauseAudit.hourly";
/** A pause outlives a dead migrate task by at most this long. */
export const SCHEDULER_DRAIN_PAUSE_BOUND_MS = 30 * 60_000;
/**
 * How long running jobs get to notice the pause. The scheduler checks it at
 * each heartbeat, a few seconds to minutes apart; a run that ignores it for
 * longer is one the promote should not cut under.
 */
export const SCHEDULER_DRAIN_DEADLINE_MS = 5 * 60_000;
export const SCHEDULER_DRAIN_POLL_MS = 1000;

const PAUSE_REASON = "Schema migration phase draining scheduled jobs";
const RESUME_REASON = "Schema migration phase finished";

/** The columns the previous release must have for its pause to take effect. */
const REQUIRED_COLUMNS = [
  "id",
  "paused_by",
  "paused_until",
  "pause_reason",
  "locked_by",
  "locked_until",
  "updated_at",
] as const;

export type LeasedSchedulerJob = {
  id: string;
  lockedBy: string | null;
  lockedUntil: Date | null;
};

export class SchedulerDrainTimeoutError extends TaggedError(
  "SchedulerDrainTimeoutError",
)<{
  message: string;
  leased: readonly LeasedSchedulerJob[];
  waitedMs: number;
}> {
  static {
    declareFingerprintFields(this, ["waitedMs"]);
  }
}

export type SchedulerDrainRuntime = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  deadlineMs: number;
  pollMs: number;
};

export const DEFAULT_SCHEDULER_DRAIN_RUNTIME: SchedulerDrainRuntime = {
  now: () => performance.now(),
  sleep: Bun.sleep,
  deadlineMs: SCHEDULER_DRAIN_DEADLINE_MS,
  pollMs: SCHEDULER_DRAIN_POLL_MS,
};

type SchedulerDrainOptions = {
  connection: ReservedSQL;
  timing: MigrationTiming;
  runtime: SchedulerDrainRuntime;
};

const hasPauseColumns = async (connection: ReservedSQL): Promise<boolean> => {
  const [row] = await connection.unsafe<{ present: number }[]>(
    `SELECT count(DISTINCT column_name)::int AS present
     FROM information_schema.columns
     WHERE table_name = 'scheduler_jobs'
       AND table_schema = ANY (current_schemas(false))
       AND column_name = ANY (string_to_array($1, ','))`,
    [REQUIRED_COLUMNS.join(",")],
  );
  return row?.present === REQUIRED_COLUMNS.length;
};

/** Pauses every job not already paused; returns exactly the ids it paused. */
const pauseJobs = async (connection: ReservedSQL): Promise<string[]> => {
  const rows = await connection.unsafe<{ id: string }[]>(
    `UPDATE scheduler_jobs
     SET paused_until = now() + $1::integer * interval '1 millisecond',
         paused_by = $2,
         pause_reason = $3,
         updated_at = now()
     WHERE id <> $4
       AND (paused_until IS NULL OR paused_until <= now())
     RETURNING id`,
    [
      SCHEDULER_DRAIN_PAUSE_BOUND_MS,
      SCHEDULER_DRAIN_ACTOR,
      PAUSE_REASON,
      UNPAUSABLE_SCHEDULER_JOB_ID,
    ],
  );
  return rows.map(({ id }) => id);
};

const readLeased = async (
  connection: ReservedSQL,
  ids: readonly string[],
): Promise<LeasedSchedulerJob[]> => {
  const rows = await connection.unsafe<
    { id: string; locked_by: string | null; locked_until: Date | null }[]
  >(
    `SELECT id, locked_by, locked_until
     FROM scheduler_jobs
     WHERE id IN (SELECT jsonb_array_elements_text($1::text::jsonb))
       AND locked_until IS NOT NULL AND locked_until >= now()
     ORDER BY id`,
    [JSON.stringify(ids)],
  );
  return rows.map(({ id, locked_by, locked_until }) => ({
    id,
    lockedBy: locked_by,
    lockedUntil: locked_until,
  }));
};

/**
 * Resumes only the rows this step paused, and only while `paused_by` is still
 * this step's: an operator pause made meanwhile is never overridden.
 */
const resumeJobs = async (
  connection: ReservedSQL,
  ids: readonly string[],
): Promise<number> => {
  const rows = await connection.unsafe<{ id: string }[]>(
    `UPDATE scheduler_jobs
     SET paused_until = NULL,
         paused_by = $2,
         pause_reason = $3,
         updated_at = now()
     WHERE id IN (SELECT jsonb_array_elements_text($1::text::jsonb))
       AND paused_by = $2
       AND paused_until IS NOT NULL
     RETURNING id`,
    [JSON.stringify(ids), SCHEDULER_DRAIN_ACTOR, RESUME_REASON],
  );
  return rows.length;
};

const errorName = (error: unknown): string =>
  error instanceof Error ? error.name : "unknown";

const resumeAndReport = async (
  { connection, timing, runtime }: SchedulerDrainOptions,
  ids: readonly string[],
): Promise<void> => {
  const startedAt = runtime.now();
  const durationMs = () => Math.max(0, Math.round(runtime.now() - startedAt));
  const resumed = await Result.tryPromise({
    try: async () => await resumeJobs(connection, ids),
    catch: (cause) => cause,
  });
  // The pause deadline resumes the jobs on its own; the outcome of the
  // migrations must not be replaced by a failure here.
  timing.emit(
    resumed.isOk()
      ? {
          event: "migrate.scheduler_resume",
          outcome: "resumed",
          pausedCount: ids.length,
          resumedCount: resumed.value,
          durationMs: durationMs(),
        }
      : {
          event: "migrate.scheduler_resume",
          outcome: "failed",
          pausedCount: ids.length,
          resumedCount: 0,
          durationMs: durationMs(),
          errorName: errorName(resumed.error),
        },
  );
};

/**
 * Pauses the scheduled jobs, waits until none holds a live lease, runs `work`,
 * and resumes the jobs it paused whether `work` returned or threw. A job still
 * leased at the deadline fails the run before `work` starts.
 */
export const withDrainedScheduler = async <T>(
  options: SchedulerDrainOptions,
  work: () => Promise<T>,
): Promise<T> => {
  const { connection, timing, runtime } = options;
  if (!(await hasPauseColumns(connection))) {
    return await work();
  }
  const startedAt = runtime.now();
  const pausedIds = await pauseJobs(connection);
  if (pausedIds.length === 0) {
    return await work();
  }

  try {
    let leased = await readLeased(connection, pausedIds);
    while (leased.length > 0) {
      const waitedMs = Math.max(0, Math.round(runtime.now() - startedAt));
      if (waitedMs >= runtime.deadlineMs) {
        timing.emit({
          event: "migrate.scheduler_drain",
          outcome: "timed_out",
          pausedCount: pausedIds.length,
          leasedCount: leased.length,
          drainWaitMs: waitedMs,
        });
        throw new SchedulerDrainTimeoutError({
          message: `Scheduled jobs still leased after ${String(waitedMs)} ms; no migration ran: ${leased
            .map(
              ({ id, lockedBy, lockedUntil }) =>
                `${id} (locked_by ${lockedBy ?? "null"}, locked_until ${lockedUntil?.toISOString() ?? "null"})`,
            )
            .join(", ")}`,
          leased,
          waitedMs,
        });
      }
      await runtime.sleep(
        Math.min(runtime.pollMs, runtime.deadlineMs - waitedMs),
      );
      leased = await readLeased(connection, pausedIds);
    }
    timing.emit({
      event: "migrate.scheduler_drain",
      outcome: "drained",
      pausedCount: pausedIds.length,
      leasedCount: 0,
      drainWaitMs: Math.max(0, Math.round(runtime.now() - startedAt)),
    });
    return await work();
  } finally {
    await resumeAndReport(options, pausedIds);
  }
};
