import { Err, panic } from "better-result";
import { and, eq, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";

import { Temporal } from "@stll/time";

import { rootDb } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
import { schedulerJobRuns, schedulerJobs } from "@/api/db/schema";
import { captureError, detached } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import {
  claimSchedulerRow,
  withAggregateSavepoint,
  withAggregateTransaction,
} from "@/api/lib/db/aggregate-lock";
import {
  ConfigurationError,
  SchedulerJobTimeoutError,
} from "@/api/lib/errors/tagged-errors";
import { errorSystemFields, errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import type { SealAgentStackOptions } from "@/api/lib/scheduler/agent-stack";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import { computeNextRunAt } from "@/api/lib/scheduler/schedule";
import type {
  SchedulerDb,
  SchedulerJob,
  SchedulerTaskRegistry,
} from "@/api/lib/scheduler/types";

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_LEASE_MS = 30 * 60_000;
const DEFAULT_JOB_LIMIT = 10;
const DEFAULT_SWEEP_DURATION_MS = 55_000;
const MIN_LEASE_MS = 3 * DEFAULT_POLL_INTERVAL_MS;

// Hard upper bound on how long a single task may run. The lease heartbeat
// renews `lockedUntil` indefinitely, so without this ceiling a task that never
// resolves would block the sequential runner AND keep the lease fresh forever,
// defeating the self-heal the lease exists for. Set to one lease period: a job
// that has not finished within a full lease is treated as hung. A JS promise
// cannot be force-cancelled, so on expiry the ceiling aborts the task's signal
// (cooperative tasks unwind), stops the heartbeat, and releases the job.
const DEFAULT_MAX_RUNTIME_MS = DEFAULT_LEASE_MS;

// The scheduler owns the postgres-role `rootDb`. Threaded explicitly so the
// claim, lease, and completion paths are exercisable against a real
// database, and handed to every task through its context.
export type { SchedulerDb };

// Agent lifecycle operations use the scheduler's owner connection; callers
// outside the runner inject a handle into the reusable seal helpers.
export const pauseAgentSchedulerForSession = async () => {
  const { pauseAgentScheduler } = await import("./agent-stack");
  await pauseAgentScheduler(rootDb);
};

export const sealAgentSchedulerStack = async ({
  registry,
  sealPath,
}: SealAgentStackOptions) => {
  const { sealAgentStack } = await import("./agent-stack");
  const sealed = await sealAgentStack(rootDb, { registry, sealPath });
  return sealed;
};

type RunSchedulerOnceOptions = {
  db?: SchedulerDb;
  jobIds?: readonly string[];
  runPausedBy?: string;
  heartbeatIntervalMs?: number;
  runnerId?: string;
  limit?: number;
  leaseMs?: number;
  maxRuntimeMs?: number;
  maxSweepDurationMs?: number;
  // Sweep budget clock; it may be monotonic in tests.
  now?: () => number;
  // Wall-clock milliseconds for eligibility tests; production uses PostgreSQL.
  eligibilityNow?: () => number;
  registry: SchedulerTaskRegistry;
  signal?: AbortSignal;
};

type RunSchedulerOnceResult = {
  acquired: number;
  failed: number;
  skipped: number;
  stoppedBecause: "aborted" | "deadlineReached" | "drained" | "limitReached";
  succeeded: number;
};

type StartSchedulerLoopOptions = RunSchedulerOnceOptions & {
  pollIntervalMs?: number;
};

type SchedulerLoop = {
  drained: Promise<void>;
  runnerId: string;
  stop: () => void;
};

export const runSchedulerOnce = async ({
  db = rootDb,
  jobIds,
  runPausedBy,
  eligibilityNow,
  heartbeatIntervalMs,
  leaseMs = DEFAULT_LEASE_MS,
  limit = DEFAULT_JOB_LIMIT,
  maxRuntimeMs = DEFAULT_MAX_RUNTIME_MS,
  maxSweepDurationMs = DEFAULT_SWEEP_DURATION_MS,
  now,
  registry,
  runnerId = defaultRunnerId(),
  signal,
}: RunSchedulerOnceOptions): Promise<RunSchedulerOnceResult> => {
  if (!Number.isInteger(limit) || limit < 1) {
    return panic("Scheduler job limit must be a positive integer");
  }

  if (!Number.isInteger(maxRuntimeMs) || maxRuntimeMs < 1) {
    return panic("Scheduler job runtime ceiling must be a positive integer");
  }

  if (!Number.isInteger(maxSweepDurationMs) || maxSweepDurationMs < 1) {
    return panic("Scheduler sweep duration must be a positive integer");
  }

  const renewEveryMs =
    heartbeatIntervalMs ?? defaultHeartbeatIntervalMs(leaseMs);
  if (!Number.isInteger(renewEveryMs) || renewEveryMs < 1) {
    return panic("Scheduler heartbeat interval must be a positive integer");
  }

  const sweepNow = now ?? (() => Temporal.Now.instant().epochMilliseconds);
  const deadline = sweepNow() + maxSweepDurationMs;
  const remainingJobIds = jobIds === undefined ? undefined : new Set(jobIds);
  const result: RunSchedulerOnceResult = {
    acquired: 0,
    failed: 0,
    skipped: 0,
    stoppedBecause: "drained",
    succeeded: 0,
  };

  while (result.acquired < limit) {
    if (signal?.aborted) {
      result.stoppedBecause = "aborted";
      break;
    }

    if (sweepNow() >= deadline) {
      result.stoppedBecause = "deadlineReached";
      break;
    }

    // Claim immediately before execution. A pass never leases work it cannot
    // start yet, so another scheduler replica remains free to process it.
    // db-await-in-loop: claims one job immediately before running it so replicas can take the rest
    const job = await acquireNextDueJob({
      db,
      ...(remainingJobIds !== undefined && { jobIds: [...remainingJobIds] }),
      runPausedBy,
      leaseMs,
      ...(eligibilityNow && { now: eligibilityNow }),
      registry,
      runnerId,
    });
    if (!job) {
      break;
    }
    result.acquired += 1;
    remainingJobIds?.delete(job.id);

    // db-await-in-loop: executes the job just leased; the next claim depends on this run finishing
    const status = await runJob({
      db,
      heartbeatIntervalMs: renewEveryMs,
      job,
      leaseMs,
      maxRuntimeMs,
      ...(eligibilityNow && { now: eligibilityNow }),
      registry,
      runnerId,
      signal,
    });
    if (status === "success") {
      result.succeeded += 1;
      continue;
    }

    if (status === "skipped") {
      result.skipped += 1;
      continue;
    }

    result.failed += 1;
  }

  if (result.acquired >= limit) {
    result.stoppedBecause = "limitReached";
  }

  return result;
};

export const startSchedulerLoop = ({
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  runnerId = defaultRunnerId(),
  ...options
}: StartSchedulerLoopOptions): SchedulerLoop => {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let resolveDrained: (() => void) | undefined;
  const drained = new Promise<void>((resolve) => {
    resolveDrained = resolve;
  });
  const controller = new AbortController();

  const resolveIfDrained = () => {
    if (stopped && !running) {
      resolveDrained?.();
    }
  };

  const scheduleNext = () => {
    if (stopped) {
      resolveIfDrained();
      return;
    }

    timer = setTimeout(() => {
      timer = undefined;
      if (stopped) {
        resolveIfDrained();
        return;
      }

      detached(runTick(), "scheduler-runner.run-tick");
    }, pollIntervalMs);
  };

  const runTick = async () => {
    running = true;
    try {
      await runSchedulerOnce({
        ...options,
        runnerId,
        signal: controller.signal,
      });
    } catch (error: unknown) {
      captureError(error, { schedulerRunnerId: runnerId });
      logger.error("scheduler.tick_failed", {
        "scheduler.runner_id": runnerId,
        "error.type": errorTag(error),
      });
    } finally {
      running = false;
      scheduleNext();
    }
  };

  timer = setTimeout(() => {
    timer = undefined;
    if (stopped) {
      resolveIfDrained();
      return;
    }

    detached(runTick(), "scheduler-runner.run-tick");
  }, 0);

  return {
    get drained() {
      return drained;
    },
    runnerId,
    stop: () => {
      stopped = true;
      controller.abort();
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      resolveIfDrained();
    },
  };
};

type AcquireNextDueJobOptions = {
  db: SchedulerDb;
  jobIds?: readonly string[];
  runPausedBy?: string | undefined;
  runnerId: string;
  leaseMs: number;
  registry: SchedulerTaskRegistry;
  now?: () => number;
};

export const acquireNextDueJob = async ({
  db,
  jobIds,
  runPausedBy,
  now,
  leaseMs,
  registry,
  runnerId,
}: AcquireNextDueJobOptions): Promise<SchedulerJob | null> => {
  if (!Number.isInteger(leaseMs) || leaseMs < MIN_LEASE_MS) {
    return panic("Scheduler lease must be at least three poll intervals");
  }

  // The claim filter is derived from the very registry `runJob` resolves the
  // task against, so the two can never disagree about what this build can run.
  const runnableTasks = [...registry.keys()];
  if (runnableTasks.length === 0) {
    return null;
  }

  const eligibilityTime = now
    ? sql`${new Date(now())}::timestamptz`
    : sql`now()`;
  const transact =
    "rollback" in db
      ? <Value>(run: (tx: Transaction) => Promise<Value>) =>
          withAggregateSavepoint(db, run)
      : <Value>(run: (tx: Transaction) => Promise<Value>) =>
          withAggregateTransaction(db, run);
  return await transact(async (tx) => {
    const candidate = await claimSchedulerRow(
      tx,
      and(
        dueJobPredicate({ runnableTasks, eligibilityTime, runPausedBy }),
        jobIds === undefined ? undefined : inArray(schedulerJobs.id, jobIds),
      ),
    );
    if (!candidate) {
      return null;
    }

    const leaseToken = acquireLeaseToken(runnerId);
    const [job] = await tx
      .update(schedulerJobs)
      .set({
        pausedUntil: null,
        lockedAt: sql`now()`,
        lockedBy: leaseToken,
        lockedUntil: leaseExpiry(leaseMs),
      })
      .where(
        and(
          eq(schedulerJobs.id, candidate.id),
          dueJobPredicate({ runnableTasks, eligibilityTime, runPausedBy }),
        ),
      )
      .returning();

    if (job === undefined) {
      return panic("Locked scheduler job disappeared before lease update");
    }
    if (runPausedBy === undefined || candidate.pausedBy !== runPausedBy) {
      return job;
    }
    return {
      ...job,
      completionPause: {
        pausedBy: runPausedBy,
        pauseReason:
          candidate.pauseReason ?? panic("A paused job requires a reason"),
      },
    };
  });
};

// A row whose task this build has no handler for is not claimable work: running
// it can only raise `ConfigurationError`, and the failure would still consume
// the row's schedule slot by advancing `nextRunAt`, delaying the replica that
// can run it. Registration retires such rows, but only at startup, so a build
// that declares a new task leaves every older replica able to claim it until
// they stop; the claim itself has to hold the line.
//
// Lease times are read and written on the database clock, so replicas whose
// clocks disagree still agree on when a lease expires.
type DueJobPredicateOptions = {
  runnableTasks: string[];
  eligibilityTime: SQL;
  runPausedBy: string | undefined;
};
const dueJobPredicate = ({
  runnableTasks,
  eligibilityTime,
  runPausedBy,
}: DueJobPredicateOptions) =>
  and(
    inArray(schedulerJobs.task, runnableTasks),
    eq(schedulerJobs.enabled, true),
    lte(schedulerJobs.nextRunAt, sql`${eligibilityTime}::timestamptz`),
    or(
      isNull(schedulerJobs.pausedUntil),
      lte(schedulerJobs.pausedUntil, sql`${eligibilityTime}::timestamptz`),
      runPausedBy === undefined
        ? undefined
        : and(
            eq(schedulerJobs.pausedBy, runPausedBy),
            sql`${schedulerJobs.pausedUntil} = 'infinity'::timestamptz`,
          ),
    ),
    or(
      isNull(schedulerJobs.lockedUntil),
      lte(schedulerJobs.lockedUntil, sql`now()`),
    ),
  );

const leaseExpiry = (leaseMs: number) =>
  sql`now() + ${leaseMs}::integer * interval '1 millisecond'`;

const defaultHeartbeatIntervalMs = (leaseMs: number): number =>
  Math.max(DEFAULT_POLL_INTERVAL_MS, Math.floor(leaseMs / 3));

type LeaseHeartbeat = {
  stop: () => void;
};

type StartLeaseHeartbeatOptions = {
  db: SchedulerDb;
  intervalMs: number;
  jobId: string;
  leaseMs: number;
  leaseToken: string;
  onLeaseLost: () => void;
  runnerId: string;
  signal: AbortSignal;
};

// A renewal that matches no row means the lease token no longer owns the job:
// the lease expired and another runner claimed it. The task is stopped through
// its signal rather than left running beside the new owner until the ceiling.
// Renewals that keep failing are treated the same way once `leaseMs` has passed
// since the start of the last one that succeeded: by then the lease may have
// expired and been claimed, and this runner cannot tell otherwise.
export const startLeaseHeartbeat = ({
  db,
  intervalMs,
  jobId,
  leaseMs,
  leaseToken,
  onLeaseLost,
  runnerId,
  signal,
}: StartLeaseHeartbeatOptions): LeaseHeartbeat => {
  let stopped = false;
  // Read through a function: `stopped` changes in `stop()` while a renewal
  // awaits, which flow narrowing cannot see.
  const isStopped = (): boolean => stopped;
  let lost = false;
  // The claim just set the lease, so it runs from here at the latest.
  let lastRenewedAt = performance.now();

  const markLost = () => {
    if (lost || stopped) {
      return;
    }
    lost = true;
    clearInterval(timer);
    logger.warn("scheduler.lease_lost", {
      "scheduler.job_id": jobId,
      "scheduler.runner_id": runnerId,
    });
    onLeaseLost();
  };

  const renew = async () => {
    if (signal.aborted) {
      return;
    }

    const attemptStartedAt = performance.now();
    const renewed = await db
      .update(schedulerJobs)
      .set({ lockedUntil: leaseExpiry(leaseMs) })
      .where(
        and(
          eq(schedulerJobs.id, jobId),
          eq(schedulerJobs.lockedBy, leaseToken),
          eq(schedulerJobs.enabled, true),
          or(
            isNull(schedulerJobs.pausedUntil),
            lte(schedulerJobs.pausedUntil, sql`now()`),
          ),
        ),
      )
      .returning({ id: schedulerJobs.id });

    // A renewal still in flight when the run completed matches no row because
    // the completion released the lease, not because another runner took it.
    if (stopped) {
      return;
    }
    if (renewed.length > 0) {
      lastRenewedAt = attemptStartedAt;
      return;
    }
    const [pausedJob] = await db
      .select({
        task: schedulerJobs.task,
        pausedBy: schedulerJobs.pausedBy,
        pauseReason: schedulerJobs.pauseReason,
      })
      .from(schedulerJobs)
      .where(
        and(
          eq(schedulerJobs.id, jobId),
          sql`${schedulerJobs.pausedUntil} > now()`,
        ),
      )
      .limit(1);
    if (isStopped()) {
      return;
    }
    if (pausedJob) {
      logPausedJob({ id: jobId, ...pausedJob });
    }
    markLost();
  };

  const timer = setInterval(() => {
    detached(
      renew().catch((error: unknown) => {
        logger.warn("scheduler.lease_heartbeat_failed", {
          "scheduler.job_id": jobId,
          "scheduler.runner_id": runnerId,
          "error.type": errorTag(error),
        });
        if (performance.now() - lastRenewedAt >= leaseMs) {
          markLost();
        }
      }),
      "scheduler-runner.renew",
    );
  }, intervalMs);

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
};

type PausedJob = Pick<SchedulerJob, "id" | "task" | "pausedBy" | "pauseReason">;

const logPausedJob = ({ id, task, pausedBy, pauseReason }: PausedJob) => {
  logger.error("scheduler.job.paused_job_ran", {
    jobId: id,
    task,
    ...(pausedBy !== null && { pausedBy }),
    ...(pauseReason !== null && { pauseReason }),
  });
};

type RunJobOptions = {
  db: SchedulerDb;
  heartbeatIntervalMs: number;
  job: SchedulerJob;
  leaseMs: number;
  maxRuntimeMs: number;
  runnerId: string;
  registry: SchedulerTaskRegistry;
  signal: AbortSignal | undefined;
  now?: () => number;
};

type RunJobStatus = "failed" | "skipped" | "success";

export const runJob = async ({
  db,
  heartbeatIntervalMs,
  job,
  leaseMs,
  maxRuntimeMs,
  now,
  registry,
  runnerId,
  signal,
}: RunJobOptions): Promise<RunJobStatus> => {
  const leaseToken = leaseTokenOf(job);
  const startedAt = new Date();
  const runId = await createRun({ db, job, runnerId, startedAt });
  // Re-read operator state: a pause may have committed after acquisition.
  const eligibilityTime = now
    ? sql`${new Date(now())}::timestamptz`
    : sql`now()`;
  const [current] = await db
    .select({
      enabled: schedulerJobs.enabled,
      paused: sql<boolean>`coalesce(${schedulerJobs.pausedUntil} > ${eligibilityTime}, false)`,
      pausedBy: schedulerJobs.pausedBy,
      pauseReason: schedulerJobs.pauseReason,
    })
    .from(schedulerJobs)
    .where(eq(schedulerJobs.id, job.id))
    .limit(1);
  if (!current) {
    return panic("Leased scheduler job disappeared before execution");
  }
  if (current.paused || !current.enabled) {
    if (current.paused) {
      logPausedJob({ id: job.id, task: job.task, ...current });
    }
    await finishRunSkipped({
      db,
      job,
      leaseToken,
      reason: current.paused
        ? "SchedulerOperatorPaused"
        : "SchedulerJobDisabled",
      runId,
      startedAt,
    });
    return "skipped";
  }

  const controller = new AbortController();
  const abortListener = () => controller.abort();
  signal?.addEventListener("abort", abortListener, { once: true });

  // A parent abort that fired while createRun() was awaited would not replay
  // through the listener attached above. Re-check synchronously and bail before
  // any task or heartbeat starts, releasing the lease cleanly.
  if (signal?.aborted) {
    controller.abort();
    signal.removeEventListener("abort", abortListener);
    await finishRunSkipped({
      db,
      job,
      leaseToken,
      reason: "SchedulerAborted",
      runId,
      startedAt,
    });
    return "skipped";
  }

  let leaseLost = false;
  // Read through a function: the heartbeat sets `leaseLost` from a callback,
  // which flow narrowing cannot see.
  const isLeaseLost = (): boolean => leaseLost;
  const heartbeat = startLeaseHeartbeat({
    db,
    intervalMs: heartbeatIntervalMs,
    jobId: job.id,
    leaseMs,
    leaseToken,
    onLeaseLost: () => {
      leaseLost = true;
      controller.abort();
    },
    runnerId,
    signal: controller.signal,
  });
  const task = registry.get(job.task);
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  // Set the instant the ceiling fires, before the abort is broadcast, and
  // consulted after the race regardless of how it settled. The race outcome
  // alone is not authoritative: a cooperative task that resolves (or rejects)
  // from its abort listener can fulfill the race even though the ceiling already
  // fired, so that fulfillment is a zombie result, not a success.
  let timeoutError: SchedulerJobTimeoutError | undefined;
  let raceError: unknown;
  let raceRejected = false;
  let continuationAt: Date | undefined;

  try {
    if (!task) {
      throw new ConfigurationError({
        message: `No scheduler task registered for ${job.task}`,
      });
    }

    // Bound the task's runtime. A JS promise cannot be force-cancelled, so on
    // expiry we abort the task's signal, giving a cooperative task a chance to
    // stop before its lease is released; a task that ignores the signal keeps
    // running as a "zombie". We never chain a completion write onto it, and the
    // guarded completion writes below reject a late write anyway, so a zombie
    // can never overwrite the timed-out state.
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutTimer = setTimeout(() => {
        const ceilingError = new SchedulerJobTimeoutError({
          jobId: job.id,
          message: `Scheduler job ${job.id} exceeded its ${maxRuntimeMs}ms runtime ceiling`,
          timeoutMs: maxRuntimeMs,
        });
        timeoutError = ceilingError;
        controller.abort();
        reject(ceilingError);
      }, maxRuntimeMs);
    });

    const outcome = await Promise.race([
      Promise.resolve(
        task({
          db,
          dueAt: DueSlot.of(job),
          job,
          logger,
          payload: job.payload,
          runId,
          scheduleContinuation: (nextRunAt) => {
            continuationAt = nextRunAt;
          },
          signal: controller.signal,
        }),
      ),
      timeout,
    ]);
    if (outcome instanceof Err) {
      raceError = outcome.error.cause;
      raceRejected = true;
    }
  } catch (error: unknown) {
    raceError = error;
    raceRejected = true;
  } finally {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
    signal?.removeEventListener("abort", abortListener);
  }

  // Stop heartbeating before any completion write: the lease must not be renewed
  // while we release it, and the completion transaction must not race a renewal
  // on the same connection.
  heartbeat.stop();

  // A short task can finish between heartbeats after a pause commits. Report
  // that overlap while still recording completed work once, avoiding replay.
  if (!isLeaseLost()) {
    const completionTime = now
      ? sql`${new Date(now())}::timestamptz`
      : sql`now()`;
    const [pausedJob] = await db
      .select({
        id: schedulerJobs.id,
        task: schedulerJobs.task,
        pausedBy: schedulerJobs.pausedBy,
        pauseReason: schedulerJobs.pauseReason,
      })
      .from(schedulerJobs)
      .where(
        and(
          eq(schedulerJobs.id, job.id),
          sql`${schedulerJobs.pausedUntil} > ${completionTime}`,
        ),
      )
      .limit(1);
    if (pausedJob) {
      logPausedJob(pausedJob);
    }
  }

  return await resolveRunOutcome({
    aborted: controller.signal.aborted,
    db,
    job,
    leaseLost,
    leaseToken,
    maxRuntimeMs,
    raceError,
    raceRejected,
    runId,
    runnerId,
    startedAt,
    continuationAt,
    timeoutError,
  });
};

type ResolveRunOutcomeOptions = {
  aborted: boolean;
  continuationAt: Date | undefined;
  db: SchedulerDb;
  job: SchedulerJob;
  leaseLost: boolean;
  leaseToken: string;
  maxRuntimeMs: number;
  raceError: unknown;
  raceRejected: boolean;
  runId: SafeId<"schedulerJobRun">;
  runnerId: string;
  startedAt: Date;
  timeoutError: SchedulerJobTimeoutError | undefined;
};

// Single-homed post-race classification, in strict precedence:
//   1. the ceiling fired  -> timeout failure: the result is a zombie, the lease
//      was already released, and the job must be rescheduled.
//   2. the lease was lost  -> skip: another runner owns the job now, so this
//      execution records nothing on the job, whatever the task returned.
//   3. the race fulfilled  -> success, even if the parent signal aborted
//      mid-flight. A finished unit of work is recorded once; re-running it (by
//      skipping and leaving nextRunAt due) would duplicate side effects, which
//      is exactly the idempotency bug this ceiling exists to prevent. Recording
//      a real completion is always safe during graceful shutdown.
//   4. the race rejected while the controller was aborted -> skip: the task did
//      not finish, it bailed on the abort, so leave it due to run again.
//   5. the race rejected on its own -> failure.
const resolveRunOutcome = async ({
  aborted,
  continuationAt,
  db,
  job,
  leaseLost,
  leaseToken,
  maxRuntimeMs,
  raceError,
  raceRejected,
  runId,
  runnerId,
  startedAt,
  timeoutError,
}: ResolveRunOutcomeOptions): Promise<RunJobStatus> => {
  if (timeoutError) {
    captureError(timeoutError, {
      schedulerJobId: job.id,
      schedulerRunId: runId,
      schedulerTask: job.task,
    });
    logger.error("scheduler.job_timed_out", {
      "scheduler.job_id": job.id,
      "scheduler.run_id": runId,
      "scheduler.runner_id": runnerId,
      "scheduler.task": job.task,
      "scheduler.timeout_ms": maxRuntimeMs,
    });
    await finishRunFailure({
      db,
      error: timeoutError,
      job,
      leaseToken,
      runId,
      startedAt,
    });
    return "failed";
  }

  if (leaseLost) {
    await finishRunSkipped({
      db,
      job,
      leaseToken,
      reason: "SchedulerLeaseLost",
      runId,
      startedAt,
    });
    return "skipped";
  }

  if (!raceRejected) {
    await finishRunSuccess({
      db,
      job,
      leaseToken,
      ...(continuationAt ? { nextRunAt: continuationAt } : {}),
      runId,
      startedAt,
    });
    return "success";
  }

  if (aborted) {
    await finishRunSkipped({
      db,
      job,
      leaseToken,
      reason: "SchedulerAborted",
      runId,
      startedAt,
    });
    return "skipped";
  }

  captureError(raceError, {
    schedulerJobId: job.id,
    schedulerRunId: runId,
    schedulerTask: job.task,
  });
  logger.error("scheduler.job_failed", {
    "scheduler.job_id": job.id,
    "scheduler.run_id": runId,
    "scheduler.runner_id": runnerId,
    "scheduler.task": job.task,
    ...errorSystemFields(raceError),
  });
  await finishRunFailure({
    db,
    error: raceError,
    job,
    leaseToken,
    runId,
    startedAt,
  });
  return "failed";
};

type CreateRunOptions = {
  db: SchedulerDb;
  job: SchedulerJob;
  runnerId: string;
  startedAt: Date;
};

const createRun = async ({
  db,
  job,
  runnerId,
  startedAt,
}: CreateRunOptions): Promise<SafeId<"schedulerJobRun">> => {
  const [run] = await db
    .insert(schedulerJobRuns)
    .values({
      jobId: job.id,
      runnerId,
      startedAt,
      status: "running",
      task: job.task,
    })
    .returning({ id: schedulerJobRuns.id });

  if (!run) {
    return panic("Scheduler run insert did not return a row");
  }

  return run.id;
};

type FinishRunOptions = {
  db: SchedulerDb;
  job: SchedulerJob;
  leaseToken: string;
  runId: SafeId<"schedulerJobRun">;
  startedAt: Date;
};

type FinishRunSuccessOptions = FinishRunOptions & {
  nextRunAt?: Date;
};

type CompleteRunOptions = {
  db: SchedulerDb;
  job: SchedulerJob;
  leaseToken: string;
  runId: SafeId<"schedulerJobRun">;
  runValues: PgUpdateSetSource<typeof schedulerJobRuns>;
  jobValues: PgUpdateSetSource<typeof schedulerJobs>;
};

// A run terminates exactly once. Every completion path (success, skipped,
// failure) funnels through this single guarded, atomic writer so a future path
// cannot forget the guard. Inside one transaction, two layers reject a late
// completion:
//   1. the run-row write is conditioned on `status = "running"` (a generation
//      check) and only counts if it actually updated a row;
//   2. the job-row write runs only when (1) won AND `lockedBy` still equals the
//      exact lease token this execution acquired (a unique-lease check).
// Because the lease token is unique per acquisition, a stale still-running
// execution cannot complete the job after it has been re-acquired -- even by the
// same runner process -- and the transaction stops the run write from committing
// without the lease check.
const completeRun = async ({
  db,
  job,
  jobValues,
  leaseToken,
  runId,
  runValues,
}: CompleteRunOptions): Promise<void> => {
  await withAggregateTransaction(db, async (tx) => {
    const [updatedRun] = await tx
      .update(schedulerJobRuns)
      .set(runValues)
      .where(
        and(
          eq(schedulerJobRuns.id, runId),
          eq(schedulerJobRuns.status, "running"),
        ),
      )
      .returning({ id: schedulerJobRuns.id });

    if (!updatedRun) {
      return;
    }

    await tx
      .update(schedulerJobs)
      .set({
        ...jobValues,
        ...(job.completionPause === undefined
          ? {}
          : {
              // A later operator pause retains its attribution and deadline.
              pausedBy: sql`CASE WHEN ${schedulerJobs.pausedUntil} IS NULL THEN ${job.completionPause.pausedBy} ELSE ${schedulerJobs.pausedBy} END`,
              pauseReason: sql`CASE WHEN ${schedulerJobs.pausedUntil} IS NULL THEN ${job.completionPause.pauseReason} ELSE ${schedulerJobs.pauseReason} END`,
              pausedUntil: sql`coalesce(${schedulerJobs.pausedUntil}, 'infinity'::timestamptz)`,
            }),
      })
      .where(
        and(
          eq(schedulerJobs.id, job.id),
          eq(schedulerJobs.lockedBy, leaseToken),
        ),
      );
  });
};

export const finishRunSuccess = async ({
  db,
  job,
  leaseToken,
  nextRunAt,
  runId,
  startedAt,
}: FinishRunSuccessOptions): Promise<void> => {
  const finishedAt = new Date();

  await completeRun({
    db,
    job,
    jobValues: {
      lastError: null,
      lastRunAt: startedAt,
      lastSuccessAt: finishedAt,
      lockedAt: null,
      lockedBy: null,
      lockedUntil: null,
      nextRunAt: nextRunAt ?? computeNextRunAt(job.schedule, finishedAt),
    },
    leaseToken,
    runId,
    runValues: {
      durationMs: durationMs(startedAt, finishedAt),
      finishedAt,
      status: "success",
    },
  });
};

type SchedulerSkipReason =
  | "SchedulerOperatorPaused"
  | "SchedulerJobDisabled"
  | "SchedulerAborted"
  | "SchedulerLeaseLost";

type FinishRunSkippedOptions = FinishRunOptions & {
  reason: SchedulerSkipReason;
};

export const finishRunSkipped = async ({
  db,
  job,
  leaseToken,
  reason,
  runId,
  startedAt,
}: FinishRunSkippedOptions): Promise<void> => {
  const finishedAt = new Date();

  await completeRun({
    db,
    job,
    jobValues: {
      lockedAt: null,
      lockedBy: null,
      lockedUntil: null,
    },
    leaseToken,
    runId,
    runValues: {
      durationMs: durationMs(startedAt, finishedAt),
      error: reason,
      finishedAt,
      status: "skipped",
    },
  });
};

type FinishRunFailureOptions = FinishRunOptions & {
  error: unknown;
};

export const finishRunFailure = async ({
  db,
  error,
  job,
  leaseToken,
  runId,
  startedAt,
}: FinishRunFailureOptions): Promise<void> => {
  const finishedAt = new Date();
  const sanitizedError = errorTag(error);

  await completeRun({
    db,
    job,
    jobValues: {
      lastError: sanitizedError,
      lastFailureAt: finishedAt,
      lastRunAt: startedAt,
      lockedAt: null,
      lockedBy: null,
      lockedUntil: null,
      nextRunAt: computeNextRunAt(job.schedule, finishedAt),
    },
    leaseToken,
    runId,
    runValues: {
      durationMs: durationMs(startedAt, finishedAt),
      error: sanitizedError,
      finishedAt,
      status: "failed",
    },
  });
};

const durationMs = (startedAt: Date, finishedAt: Date): number =>
  Math.max(0, finishedAt.getTime() - startedAt.getTime());

const defaultRunnerId = (): string => {
  const host = process.env["HOSTNAME"] ?? "local";
  return `${host}:${process.pid}:${Bun.randomUUIDv7()}`;
};

// scheduler_jobs.locked_by is varchar(128). The lease token binds a completion
// to one specific acquisition: a globally-unique suffix means re-acquiring the
// same job (even within the same runner process) yields a different token, so a
// stale still-running execution can no longer satisfy the completion guard. The
// runnerId prefix is kept for observability but truncated so the token always
// fits the column.
const LEASE_TOKEN_COLUMN_LENGTH = 128;

const acquireLeaseToken = (runnerId: string): string => {
  const suffix = `#${Bun.randomUUIDv7()}`;
  const prefix = runnerId.slice(0, LEASE_TOKEN_COLUMN_LENGTH - suffix.length);
  return `${prefix}${suffix}`;
};

// After a successful claim the acquired row carries its lease token in
// `lockedBy`; every downstream lease operation matches against exactly that
// token rather than the reusable runnerId.
const leaseTokenOf = (job: SchedulerJob): string =>
  job.lockedBy ?? panic("Leased scheduler job is missing its lease token");
