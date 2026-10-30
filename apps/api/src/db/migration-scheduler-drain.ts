/**
 * Scheduled jobs around the schema migration phase.
 *
 * The migrate task runs the new release's code while the previous release's
 * scheduler keeps running. A scheduled job inside a long read transaction
 * holds a lock that refuses the schema phase's `ACCESS EXCLUSIVE` DDL, and the
 * lock-wait ladder cannot outlast it. The scheduler honours
 * `scheduler_jobs.paused_until`: a paused job cannot start again, and a
 * running one notices the pause only at its next heartbeat and releases its
 * lease only when its task settles, which the scheduler bounds with its
 * runtime ceiling. This module pauses the jobs before the pending schema
 * migrations, waits for the running ones to finish naturally (up to that
 * ceiling plus a margin), and resumes them afterwards.
 *
 * No job-to-table map exists, and a hand-listed subset would drift, so every
 * job is paused except the pause audit (the database forbids pausing it).
 * The invariant before the migrations run: every other job stays paused for
 * at least the work floor, whoever paused it. Pauses of other actors that end
 * sooner are taken over and restored exactly; pauses that last are untouched.
 * The step's pause carries a deadline, so a migrate task that dies leaves no
 * job paused for long.
 *
 * What "drained" means: no job STARTS, and every leased run has settled or hit
 * its runtime ceiling. It means no live lease, not no open transaction. A task
 * that ignores the abort past its ceiling can still hold a transaction; the
 * schema phase's lock-wait ladder then refuses within its budget and the
 * migration rolls back with the blockers named. The outcome is fail-safe, not
 * silent.
 *
 * Scope: this covers scheduler jobs only. Application request reads are not
 * drained; they still rely on the lock-wait ladder.
 *
 * Relative imports only: `migrate.ts` ships as a loose file.
 */

import { panic, Result, TaggedError } from "better-result";
import type { ReservedSQL } from "bun";

import { declareFingerprintFields } from "@stll/errors";

import {
  DEFAULT_LEASE_MS,
  DEFAULT_MAX_RUNTIME_MS,
  defaultHeartbeatIntervalMs,
} from "../lib/scheduler/timing";
import { DEFAULT_LOCK_RETRY_CONFIG } from "./lock-retry-ladder";
import type { MigrationTiming } from "./migration-timing";
import type { OnlineMigrationConnection } from "./online-migration-connection";

/**
 * `paused_by` of every pause this step writes; resumes match on it. A resume
 * clears the deadline but keeps this value, so only an ACTIVE pause with it
 * marks a job as already paused by a running step.
 */
export const SCHEDULER_DRAIN_ACTOR = "migrate";
/** The one job the database refuses to pause. */
export const UNPAUSABLE_SCHEDULER_JOB_ID = "scheduler.pauseAudit.hourly";
/** Slack for clock skew and a sweep that began just before the pause. */
const SCHEDULER_DRAIN_MARGIN_MS = 5 * 60_000;
/** The DDL itself, once the lock is won; the schema phase is short. */
const SCHEDULER_DRAIN_DDL_ALLOWANCE_MS = 15 * 60_000;
/**
 * How long running jobs get to finish. A run that began before the pause lasts
 * at most the runtime ceiling (it notices the pause at a heartbeat, every
 * `defaultHeartbeatIntervalMs(lease)`, and unwinds sooner); the margin covers
 * the rest.
 */
export const SCHEDULER_DRAIN_DEADLINE_MS =
  Math.max(
    DEFAULT_MAX_RUNTIME_MS,
    defaultHeartbeatIntervalMs(DEFAULT_LEASE_MS),
  ) + SCHEDULER_DRAIN_MARGIN_MS;
/** What the work needs once the drain ends: the lock-wait ladder, the DDL, a margin. */
export const SCHEDULER_DRAIN_WORK_FLOOR_MS =
  DEFAULT_LOCK_RETRY_CONFIG.budgetMs +
  SCHEDULER_DRAIN_DDL_ALLOWANCE_MS +
  SCHEDULER_DRAIN_MARGIN_MS;
/** What a pause needs when the drain starts: the whole wait, then the work. */
export const SCHEDULER_DRAIN_START_FLOOR_MS =
  SCHEDULER_DRAIN_DEADLINE_MS + SCHEDULER_DRAIN_WORK_FLOOR_MS;
/**
 * The step's own pause, written above the start floor so it is not eligible
 * again while the scans that follow its write run. A dead migrate task leaves
 * a pause that lapses within this long (the database caps pauses at 72 h).
 */
export const SCHEDULER_DRAIN_PAUSE_BOUND_MS =
  SCHEDULER_DRAIN_START_FLOOR_MS + SCHEDULER_DRAIN_MARGIN_MS;
export const SCHEDULER_DRAIN_POLL_MS = 5000;
/**
 * While the work runs, the step's pauses are renewed this often, well inside
 * the work floor they renew to, so a long schema step never outlasts them.
 */
export const SCHEDULER_DRAIN_RENEW_EVERY_MS = SCHEDULER_DRAIN_WORK_FLOOR_MS / 4;
/** One progress event per still-leased job at most this often. */
export const SCHEDULER_DRAIN_PROGRESS_MS = 60_000;

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
  /** Runs `run` every `intervalMs` until the returned function is called. */
  repeat: (run: () => Promise<void>, intervalMs: number) => () => void;
};

export const DEFAULT_SCHEDULER_DRAIN_RUNTIME: SchedulerDrainRuntime = {
  now: () => performance.now(),
  sleep: Bun.sleep,
  deadlineMs: SCHEDULER_DRAIN_DEADLINE_MS,
  pollMs: SCHEDULER_DRAIN_POLL_MS,
  repeat: (run, intervalMs) => {
    // `run` reports its own failures and never rejects.
    const timer = setInterval(run, intervalMs);
    return () => {
      clearInterval(timer);
    };
  },
};

type SchedulerDrainOptions = {
  connection: ReservedSQL;
  timing: MigrationTiming;
  runtime: SchedulerDrainRuntime;
  /** Whether schema migrations are pending; without any there is nothing to drain for. */
  pending: boolean;
  /** A session apart from `connection`, which is busy while the work runs. */
  openRenewalConnection: () => Promise<OnlineMigrationConnection>;
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

/**
 * What a resume does to one job. The latest transition wins: a job paused from
 * unpaused whose pause another actor then replaces, and a later pass takes
 * over, becomes a restore; an adoption stays a clear.
 */
type Restoration =
  | { kind: "clear" }
  | {
      kind: "restore";
      /** Another actor's pause as it was before the takeover. */
      pausedBy: string;
      pauseReason: string;
      /** Rendered by PostgreSQL, so microseconds and offset survive the round trip. */
      pausedUntil: string;
    };

/** One restoration per job id this step has written. */
type PauseOutcome = Map<string, Restoration>;

const countRestorations = (
  outcome: PauseOutcome,
): { pausedCount: number; takenOverCount: number } => {
  let takenOverCount = 0;
  for (const restoration of outcome.values()) {
    if (restoration.kind === "restore") {
      takenOverCount += 1;
    }
  }
  return {
    pausedCount: outcome.size - takenOverCount,
    takenOverCount,
  };
};

/**
 * The invariant before `work` starts: every pausable row stays paused for at
 * least the pause floor, whoever paused it. A row is eligible while it is not.
 * The floor sits below the pause bound the step writes, so the step's own
 * pause never counts as eligible again as time passes.
 */
const eligibleSql = (floor: string, audit: string) =>
  `id <> ${audit}
         AND (paused_until IS NULL
              OR paused_until < now() + ${floor}::integer * interval '1 millisecond')`;

const readEligible = async (
  connection: ReservedSQL,
  floorMs: number,
): Promise<string[]> => {
  const rows = await connection.unsafe<{ id: string }[]>(
    `SELECT id FROM scheduler_jobs WHERE ${eligibleSql("$1", "$2")} ORDER BY id`,
    [floorMs, UNPAUSABLE_SCHEDULER_JOB_ID],
  );
  return rows.map(({ id }) => id);
};

/**
 * One statement pauses every eligible job and returns the pauses it replaced.
 * An unpaused or expired job is paused; a pause of this step ending sooner is
 * adopted (extended, cleared on resume, there is no other state to restore);
 * another actor's pause ending sooner is taken over and restored exactly.
 * `paused_since` is kept by the database trigger, which preserves it while one
 * active pause replaces another. A row changed after the scan fails the
 * write's compare-and-set and is left for the next pass.
 */
const pauseOnce = async (
  connection: ReservedSQL,
  floorMs: number,
): Promise<PauseOutcome> => {
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
              coalesce(paused_until > now() AND paused_by <> $2, false) AS taken_over,
              paused_until::text AS paused_until_text
       FROM scheduler_jobs
       WHERE ${eligibleSql("$4", "$5")}
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
      floorMs,
      UNPAUSABLE_SCHEDULER_JOB_ID,
    ],
  );
  const outcome: PauseOutcome = new Map();
  for (const row of rows) {
    if (
      row.taken_over &&
      row.paused_by !== null &&
      row.pause_reason !== null &&
      row.paused_until_text !== null
    ) {
      outcome.set(row.id, {
        kind: "restore",
        pausedBy: row.paused_by,
        pauseReason: row.pause_reason,
        pausedUntil: row.paused_until_text,
      });
      continue;
    }
    outcome.set(row.id, { kind: "clear" });
  }
  return outcome;
};

/** Passes after which a job still changing under the step is a bug, not a race. */
const MAX_PAUSE_PASSES = 5;

/**
 * Repeats the pause until a fresh scan finds no job paused for less than
 * `floorMs`: a pass that wrote nothing proves nothing, since compare-and-set
 * losers are retried. Progress accumulates in `total`, so a failure part-way
 * still leaves the caller the list of what to undo.
 */
const pauseJobs = async (
  connection: ReservedSQL,
  floorMs: number,
  total: PauseOutcome,
): Promise<number> => {
  let written = 0;
  for (let pass = 0; ; pass += 1) {
    const eligible = await readEligible(connection, floorMs);
    if (eligible.length === 0) {
      return written;
    }
    if (pass === MAX_PAUSE_PASSES) {
      return panic(
        `Scheduler jobs kept changing; the drain could not pause: ${eligible.join(", ")}`,
      );
    }
    const outcome = await pauseOnce(connection, floorMs);
    for (const [id, restoration] of outcome) {
      total.set(id, restoration);
    }
    written += outcome.size;
  }
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
  paused: PauseOutcome,
): Promise<{ resumedCount: number; restoredCount: number }> => {
  const pausedIds: string[] = [];
  const takenOver: {
    id: string;
    pausedBy: string;
    pauseReason: string;
    pausedUntil: string;
  }[] = [];
  for (const [id, restoration] of paused) {
    switch (restoration.kind) {
      case "clear":
        pausedIds.push(id);
        break;
      case "restore":
        takenOver.push({ id, ...restoration });
        break;
      default:
        restoration satisfies never;
        return panic("Unknown scheduler drain restoration");
    }
  }
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

type RenewalStats = { renewalCount: number; renewalFailureCount: number };

const resumeAndReport = async (
  { connection, timing, runtime }: SchedulerDrainOptions,
  paused: PauseOutcome,
  renewals: RenewalStats,
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
          ...countRestorations(paused),
          resumedCount: resumed.value.resumedCount,
          restoredCount: resumed.value.restoredCount,
          ...renewals,
          durationMs: durationMs(),
        }
      : {
          event: "migrate.scheduler_resume",
          outcome: "failed",
          ...countRestorations(paused),
          resumedCount: 0,
          restoredCount: 0,
          ...renewals,
          durationMs: durationMs(),
          errorName: errorName(resumed.error),
        },
  );
};

/**
 * Extends the step's pauses to the work floor, only for jobs this run wrote
 * and only while `paused_by` is still the step's, so a row someone else
 * rewrote is never touched; a pause already longer is never shortened.
 */
const RENEW_SQL = `UPDATE scheduler_jobs
   SET paused_until = now() + $3::integer * interval '1 millisecond',
       updated_at = now()
   WHERE id IN (SELECT jsonb_array_elements_text($1::text::jsonb))
     AND paused_by = $2
     AND paused_until IS NOT NULL
     AND paused_until < now() + $3::integer * interval '1 millisecond'
   RETURNING id`;

type Renewal = { stats: RenewalStats; stop: () => Promise<void> };

/**
 * Keeps the pauses alive while `work` runs. A failure is reported and never
 * aborts the work, which may be mid-DDL; the next tick tries again.
 */
const startRenewal = async (
  { timing, runtime, openRenewalConnection }: SchedulerDrainOptions,
  paused: PauseOutcome,
): Promise<Renewal> => {
  const stats: RenewalStats = { renewalCount: 0, renewalFailureCount: 0 };
  const reportFailure = (cause: unknown) => {
    stats.renewalFailureCount += 1;
    timing.emit({
      event: "migrate.scheduler_renewal_failed",
      errorName: errorName(cause),
    });
  };
  const opened = await Result.tryPromise({
    try: async () => await openRenewalConnection(),
    catch: (cause) => cause,
  });
  if (opened.isErr()) {
    reportFailure(opened.error);
    return { stats, stop: async () => undefined };
  }
  const renewalConnection = opened.value;
  const ids = JSON.stringify([...paused.keys()]);
  let stopped = false;
  let inflight: Promise<void> = Promise.resolve();
  const tick = async () => {
    if (stopped) {
      return;
    }
    const renewed = await Result.tryPromise({
      try: async () =>
        await renewalConnection.query(RENEW_SQL, [
          ids,
          SCHEDULER_DRAIN_ACTOR,
          SCHEDULER_DRAIN_WORK_FLOOR_MS,
        ]),
      catch: (cause) => cause,
    });
    if (renewed.isErr()) {
      reportFailure(renewed.error);
      return;
    }
    if (renewed.value.length > 0) {
      stats.renewalCount += 1;
    }
  };
  const cancel = runtime.repeat(() => {
    inflight = tick();
    return inflight;
  }, SCHEDULER_DRAIN_RENEW_EVERY_MS);
  return {
    stats,
    stop: async () => {
      stopped = true;
      cancel();
      await inflight;
      const released = await Result.tryPromise({
        try: async () => await renewalConnection.release(),
        catch: (cause) => cause,
      });
      if (released.isErr()) {
        reportFailure(released.error);
      }
    },
  };
};

/**
 * Pauses every pausable job for the whole wait plus the work, waits until none
 * holds a live lease (jobs paused by others included), re-asserts the pause
 * floor for the work itself, runs `work`, and undoes only its own writes
 * whether `work` returned or threw. A job still leased at the deadline fails
 * the run before `work` starts.
 */
export const withDrainedScheduler = async <T>(
  options: SchedulerDrainOptions,
  work: () => Promise<T>,
): Promise<T> => {
  const { connection, timing, runtime } = options;
  if (!options.pending || !(await hasPauseColumns(connection))) {
    return await work();
  }
  const startedAt = runtime.now();
  const waitedMs = () => Math.max(0, Math.round(runtime.now() - startedAt));
  const paused: PauseOutcome = new Map();
  let renewals: RenewalStats = { renewalCount: 0, renewalFailureCount: 0 };

  try {
    // The first pass must outlast the wait; later passes need only the work
    // floor, and catch a pause an operator cleared or shortened meanwhile.
    let floorMs = SCHEDULER_DRAIN_START_FLOOR_MS;
    let lastProgressAt = Number.NEGATIVE_INFINITY;
    for (;;) {
      const written = await pauseJobs(connection, floorMs, paused);
      floorMs = SCHEDULER_DRAIN_WORK_FLOOR_MS;
      const leased = await readLeased(connection);
      if (leased.length === 0 && written === 0) {
        break;
      }
      if (leased.length === 0) {
        continue;
      }
      if (waitedMs() >= runtime.deadlineMs) {
        timing.emit({
          event: "migrate.scheduler_drain",
          outcome: "timed_out",
          ...countRestorations(paused),
          leasedCount: leased.length,
          drainWaitMs: waitedMs(),
        });
        throw new SchedulerDrainTimeoutError({
          message: `Scheduled jobs still leased after ${String(waitedMs())} ms; no migration ran: ${leased
            .map(
              ({ id, lockedBy, lockedUntil }) =>
                `${id} (locked_by ${lockedBy ?? "null"}, locked_until ${lockedUntil?.toISOString() ?? "null"})`,
            )
            .join(", ")}`,
          leased,
          waitedMs: waitedMs(),
        });
      }
      if (runtime.now() - lastProgressAt >= SCHEDULER_DRAIN_PROGRESS_MS) {
        lastProgressAt = runtime.now();
        for (const { id, lockedBy, lockedUntil } of leased) {
          timing.emit({
            event: "migrate.scheduler_drain_progress",
            jobId: id,
            lockedBy,
            lockedUntil: lockedUntil?.toISOString() ?? null,
            drainWaitMs: waitedMs(),
          });
        }
      }
      await runtime.sleep(
        Math.min(runtime.pollMs, runtime.deadlineMs - waitedMs()),
      );
    }
    timing.emit({
      event: "migrate.scheduler_drain",
      outcome: "drained",
      ...countRestorations(paused),
      leasedCount: 0,
      drainWaitMs: waitedMs(),
    });
    const renewal = await startRenewal(options, paused);
    try {
      return await work();
    } finally {
      // Renewal ends before the resume, so it can never extend a pause the
      // resume has cleared.
      await renewal.stop();
      renewals = renewal.stats;
    }
  } finally {
    if (paused.size > 0) {
      await resumeAndReport(options, paused, renewals);
    }
  }
};
