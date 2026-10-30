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

import { panic, Result, TaggedError } from "better-result";
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

/** An operator pause that ends within the pause bound, as it was before the takeover. */
type TakenOverPause = {
  id: string;
  pausedBy: string;
  pauseReason: string;
  /** Rendered by PostgreSQL, so microseconds and offset survive the round trip. */
  pausedUntil: string;
};

type PauseOutcome = {
  /** Jobs that were not paused; cleared on resume. */
  pausedIds: string[];
  /** Operator pauses that would have ended during the schema phase; restored on resume. */
  takenOver: TakenOverPause[];
};

/**
 * One statement pauses every job whose pause (if any) ends before this step's
 * would, and returns the pauses it replaced. A pause that outlasts the step's
 * bound stays untouched. `paused_since` is kept by the database trigger, which
 * preserves it while one active pause replaces another.
 */
const pauseOnce = async (connection: ReservedSQL): Promise<PauseOutcome> => {
  const rows = await connection.unsafe<
    {
      id: string;
      taken_over: boolean;
      paused_by: string | null;
      pause_reason: string | null;
      paused_until_text: string | null;
    }[]
  >(
    `WITH targets AS (
       SELECT id, paused_by, pause_reason, paused_until AS raw_paused_until,
              coalesce(paused_until > now(), false) AS taken_over,
              paused_until::text AS paused_until_text
       FROM scheduler_jobs
       WHERE id <> $4
         AND paused_by IS DISTINCT FROM $2
         AND (paused_until IS NULL
              OR paused_until < now() + $1::integer * interval '1 millisecond')
     ), paused AS (
       UPDATE scheduler_jobs job
       SET paused_until = now() + $1::integer * interval '1 millisecond',
           paused_by = $2,
           pause_reason = $3,
           updated_at = now()
       FROM targets
       WHERE job.id = targets.id
         AND job.paused_by IS NOT DISTINCT FROM targets.paused_by
         AND job.paused_until IS NOT DISTINCT FROM targets.raw_paused_until
       RETURNING job.id
     )
     SELECT targets.id, targets.taken_over, targets.paused_by,
            targets.pause_reason, targets.paused_until_text
     FROM targets JOIN paused ON paused.id = targets.id
     ORDER BY targets.id`,
    [
      SCHEDULER_DRAIN_PAUSE_BOUND_MS,
      SCHEDULER_DRAIN_ACTOR,
      PAUSE_REASON,
      UNPAUSABLE_SCHEDULER_JOB_ID,
    ],
  );
  const outcome: PauseOutcome = { pausedIds: [], takenOver: [] };
  for (const row of rows) {
    if (
      row.taken_over &&
      row.paused_by !== null &&
      row.pause_reason !== null &&
      row.paused_until_text !== null
    ) {
      outcome.takenOver.push({
        id: row.id,
        pausedBy: row.paused_by,
        pauseReason: row.pause_reason,
        pausedUntil: row.paused_until_text,
      });
      continue;
    }
    outcome.pausedIds.push(row.id);
  }
  return outcome;
};

/** Passes after which a job still changing under the step is a bug, not a race. */
const MAX_PAUSE_PASSES = 5;

/**
 * A row an operator changes between the scan and the write fails the write's
 * compare-and-set (PostgreSQL rechecks it against the new row version), so it
 * is skipped rather than overwritten with stale originals; another pass picks
 * it up. The loop ends on the first pass that pauses nothing.
 */
const pauseJobs = async (connection: ReservedSQL): Promise<PauseOutcome> => {
  const total: PauseOutcome = { pausedIds: [], takenOver: [] };
  for (let pass = 0; pass < MAX_PAUSE_PASSES; pass += 1) {
    const outcome = await pauseOnce(connection);
    if (outcome.pausedIds.length + outcome.takenOver.length === 0) {
      return total;
    }
    total.pausedIds.push(...outcome.pausedIds);
    total.takenOver.push(...outcome.takenOver);
  }
  return panic("Scheduler jobs kept changing; the drain could not pause them");
};

/**
 * Live leases on every pausable job, whoever paused it: a job an operator
 * paused may still be mid-run until its runner meets the pause at a heartbeat.
 */
const readLeased = async (
  connection: ReservedSQL,
): Promise<LeasedSchedulerJob[]> => {
  const rows = await connection.unsafe<
    { id: string; locked_by: string | null; locked_until: Date | null }[]
  >(
    `SELECT id, locked_by, locked_until
     FROM scheduler_jobs
     WHERE id <> $1
       AND locked_until IS NOT NULL AND locked_until >= now()
     ORDER BY id`,
    [UNPAUSABLE_SCHEDULER_JOB_ID],
  );
  return rows.map(({ id, locked_by, locked_until }) => ({
    id,
    lockedBy: locked_by,
    lockedUntil: locked_until,
  }));
};

/**
 * Clears the pauses this step wrote on unpaused jobs and restores the operator
 * pauses it replaced, both only while `paused_by` is still this step's: a
 * pause written meanwhile is never overridden. A restored deadline that has
 * passed means "elapsed", which the runner treats as resumed.
 */
const resumeJobs = async (
  connection: ReservedSQL,
  { pausedIds, takenOver }: PauseOutcome,
): Promise<{ resumedCount: number; restoredCount: number }> => {
  const cleared = await connection.unsafe<{ id: string }[]>(
    `UPDATE scheduler_jobs
     SET paused_until = NULL,
         paused_by = $2,
         pause_reason = $3,
         updated_at = now()
     WHERE id IN (SELECT jsonb_array_elements_text($1::text::jsonb))
       AND paused_by = $2
       AND paused_until IS NOT NULL
     RETURNING id`,
    [JSON.stringify(pausedIds), SCHEDULER_DRAIN_ACTOR, RESUME_REASON],
  );
  const restored = await connection.unsafe<{ id: string }[]>(
    `UPDATE scheduler_jobs job
     SET paused_until = original.paused_until::timestamptz,
         paused_by = original.paused_by,
         pause_reason = original.pause_reason,
         updated_at = now()
     FROM jsonb_to_recordset($1::text::jsonb) AS original(
       id text, paused_by text, pause_reason text, paused_until text
     )
     WHERE job.id = original.id
       AND job.paused_by = $2
       AND job.paused_until IS NOT NULL
     RETURNING job.id`,
    [
      JSON.stringify(
        takenOver.map(({ id, pausedBy, pauseReason, pausedUntil }) => ({
          id,
          paused_by: pausedBy,
          pause_reason: pauseReason,
          paused_until: pausedUntil,
        })),
      ),
      SCHEDULER_DRAIN_ACTOR,
    ],
  );
  return { resumedCount: cleared.length, restoredCount: restored.length };
};

const errorName = (error: unknown): string =>
  error instanceof Error ? error.name : "unknown";

const resumeAndReport = async (
  { connection, timing, runtime }: SchedulerDrainOptions,
  paused: PauseOutcome,
): Promise<void> => {
  const startedAt = runtime.now();
  const durationMs = () => Math.max(0, Math.round(runtime.now() - startedAt));
  const resumed = await Result.tryPromise({
    try: async () => await resumeJobs(connection, paused),
    catch: (cause) => cause,
  });
  // The pause deadline resumes the jobs on its own; the outcome of the
  // migrations must not be replaced by a failure here.
  timing.emit(
    resumed.isOk()
      ? {
          event: "migrate.scheduler_resume",
          outcome: "resumed",
          pausedCount: paused.pausedIds.length,
          takenOverCount: paused.takenOver.length,
          resumedCount: resumed.value.resumedCount,
          restoredCount: resumed.value.restoredCount,
          durationMs: durationMs(),
        }
      : {
          event: "migrate.scheduler_resume",
          outcome: "failed",
          pausedCount: paused.pausedIds.length,
          takenOverCount: paused.takenOver.length,
          resumedCount: 0,
          restoredCount: 0,
          durationMs: durationMs(),
          errorName: errorName(resumed.error),
        },
  );
};

/**
 * Pauses the scheduled jobs, taking over operator pauses that would end within
 * the pause bound (and leaving longer ones untouched), waits until no pausable job
 * holds a live lease (operator-paused ones included), runs
 * `work`, and undoes only its own writes whether `work` returned or
 * threw. A job still leased at the deadline fails the run before `work` starts.
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
  const paused = await pauseJobs(connection);

  try {
    let leased = await readLeased(connection);
    while (leased.length > 0) {
      const waitedMs = Math.max(0, Math.round(runtime.now() - startedAt));
      if (waitedMs >= runtime.deadlineMs) {
        timing.emit({
          event: "migrate.scheduler_drain",
          outcome: "timed_out",
          pausedCount: paused.pausedIds.length,
          takenOverCount: paused.takenOver.length,
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
      leased = await readLeased(connection);
    }
    timing.emit({
      event: "migrate.scheduler_drain",
      outcome: "drained",
      pausedCount: paused.pausedIds.length,
      takenOverCount: paused.takenOver.length,
      leasedCount: 0,
      drainWaitMs: Math.max(0, Math.round(runtime.now() - startedAt)),
    });
    return await work();
  } finally {
    if (paused.pausedIds.length + paused.takenOver.length > 0) {
      await resumeAndReport(options, paused);
    }
  }
};
