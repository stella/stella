import { panic } from "better-result";
import { and, asc, eq, isNull, lte, or } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";

import { rootDb } from "@/api/db/root";
import { schedulerJobRuns, schedulerJobs } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { detached } from "@/api/lib/detached";
import {
  ConfigurationError,
  SchedulerJobTimeoutError,
} from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { createSchedulerTaskRegistry } from "@/api/lib/scheduler/registry";
import { computeNextRunAt } from "@/api/lib/scheduler/schedule";
import type {
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

// The scheduler owns the postgres-role `rootDb`; tests inject a structurally
// equivalent database handle. Threaded explicitly so the claim, lease, and
// completion paths are exercisable against a real (PGlite) database.
export type SchedulerDb = typeof rootDb;

type RunSchedulerOnceOptions = {
  db?: SchedulerDb;
  runnerId?: string;
  limit?: number;
  leaseMs?: number;
  maxRuntimeMs?: number;
  maxSweepDurationMs?: number;
  now?: () => number;
  registry?: SchedulerTaskRegistry;
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
  leaseMs = DEFAULT_LEASE_MS,
  limit = DEFAULT_JOB_LIMIT,
  maxRuntimeMs = DEFAULT_MAX_RUNTIME_MS,
  maxSweepDurationMs = DEFAULT_SWEEP_DURATION_MS,
  now = Date.now,
  registry = createSchedulerTaskRegistry(),
  runnerId = defaultRunnerId(),
  signal,
}: RunSchedulerOnceOptions = {}): Promise<RunSchedulerOnceResult> => {
  if (!Number.isInteger(limit) || limit < 1) {
    return panic("Scheduler job limit must be a positive integer");
  }

  if (!Number.isInteger(maxRuntimeMs) || maxRuntimeMs < 1) {
    return panic("Scheduler job runtime ceiling must be a positive integer");
  }

  if (!Number.isInteger(maxSweepDurationMs) || maxSweepDurationMs < 1) {
    return panic("Scheduler sweep duration must be a positive integer");
  }

  const deadline = now() + maxSweepDurationMs;
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

    if (now() >= deadline) {
      result.stoppedBecause = "deadlineReached";
      break;
    }

    // Claim immediately before execution. A pass never leases work it cannot
    // start yet, so another scheduler replica remains free to process it.
    // oxlint-disable-next-line no-await-in-loop -- sequential claim-and-run is the scheduler's fairness boundary
    const job = await acquireNextDueJob({ db, leaseMs, runnerId });
    if (!job) {
      break;
    }
    result.acquired += 1;

    // oxlint-disable-next-line no-await-in-loop -- scheduler jobs intentionally run one at a time per replica
    const status = await runJob({
      db,
      job,
      leaseMs,
      maxRuntimeMs,
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
}: StartSchedulerLoopOptions = {}): SchedulerLoop => {
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

      detached(runTick(), "scheduleNext");
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

    detached(runTick(), "startSchedulerLoop");
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
  runnerId: string;
  leaseMs: number;
};

export const acquireNextDueJob = async ({
  db,
  leaseMs,
  runnerId,
}: AcquireNextDueJobOptions): Promise<SchedulerJob | null> => {
  if (!Number.isInteger(leaseMs) || leaseMs < MIN_LEASE_MS) {
    return panic("Scheduler lease must be at least three poll intervals");
  }

  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);
  return await db.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(schedulerJobs)
      .where(dueJobPredicate(now))
      .orderBy(asc(schedulerJobs.nextRunAt), asc(schedulerJobs.id))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!candidate) {
      return null;
    }

    const leaseToken = acquireLeaseToken(runnerId);
    const [job] = await tx
      .update(schedulerJobs)
      .set({
        lockedAt: now,
        lockedBy: leaseToken,
        lockedUntil: leaseExpiresAt,
      })
      .where(and(eq(schedulerJobs.id, candidate.id), dueJobPredicate(now)))
      .returning();

    return job ?? panic("Locked scheduler job disappeared before lease update");
  });
};

const dueJobPredicate = (now: Date) =>
  and(
    eq(schedulerJobs.enabled, true),
    lte(schedulerJobs.nextRunAt, now),
    or(isNull(schedulerJobs.lockedUntil), lte(schedulerJobs.lockedUntil, now)),
  );

type LeaseHeartbeat = {
  stop: () => void;
};

type StartLeaseHeartbeatOptions = {
  db: SchedulerDb;
  jobId: string;
  leaseMs: number;
  leaseToken: string;
  runnerId: string;
  signal: AbortSignal;
};

const startLeaseHeartbeat = ({
  db,
  jobId,
  leaseMs,
  leaseToken,
  runnerId,
  signal,
}: StartLeaseHeartbeatOptions): LeaseHeartbeat => {
  const intervalMs = Math.max(
    DEFAULT_POLL_INTERVAL_MS,
    Math.floor(leaseMs / 3),
  );

  const renew = async () => {
    if (signal.aborted) {
      return;
    }

    await db
      .update(schedulerJobs)
      .set({
        lockedUntil: new Date(Date.now() + leaseMs),
      })
      .where(
        and(
          eq(schedulerJobs.id, jobId),
          eq(schedulerJobs.lockedBy, leaseToken),
        ),
      );
  };

  const timer = setInterval(() => {
    detached(
      renew().catch((error: unknown) => {
        logger.warn("scheduler.lease_heartbeat_failed", {
          "scheduler.job_id": jobId,
          "scheduler.runner_id": runnerId,
          "error.type": errorTag(error),
        });
      }),
      "startLeaseHeartbeat",
    );
  }, intervalMs);

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
};

type RunJobOptions = {
  db: SchedulerDb;
  job: SchedulerJob;
  leaseMs: number;
  maxRuntimeMs: number;
  runnerId: string;
  registry: SchedulerTaskRegistry;
  signal: AbortSignal | undefined;
};

type RunJobStatus = "failed" | "skipped" | "success";

const runJob = async ({
  db,
  job,
  leaseMs,
  maxRuntimeMs,
  registry,
  runnerId,
  signal,
}: RunJobOptions): Promise<RunJobStatus> => {
  const leaseToken = leaseTokenOf(job);
  const startedAt = new Date();
  const runId = await createRun({ db, job, runnerId, startedAt });
  const controller = new AbortController();
  const abortListener = () => controller.abort();
  signal?.addEventListener("abort", abortListener, { once: true });

  // A parent abort that fired while createRun() was awaited would not replay
  // through the listener attached above. Re-check synchronously and bail before
  // any task or heartbeat starts, releasing the lease cleanly.
  if (signal?.aborted) {
    controller.abort();
    signal.removeEventListener("abort", abortListener);
    await finishRunSkipped({ db, job, leaseToken, runId, startedAt });
    return "skipped";
  }

  const heartbeat = startLeaseHeartbeat({
    db,
    jobId: job.id,
    leaseMs,
    leaseToken,
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

    await Promise.race([
      Promise.resolve(
        task({
          job,
          logger,
          payload: job.payload,
          runId,
          signal: controller.signal,
        }),
      ),
      timeout,
    ]);
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

  return await resolveRunOutcome({
    aborted: controller.signal.aborted,
    db,
    job,
    leaseToken,
    maxRuntimeMs,
    raceError,
    raceRejected,
    runId,
    runnerId,
    startedAt,
    timeoutError,
  });
};

type ResolveRunOutcomeOptions = {
  aborted: boolean;
  db: SchedulerDb;
  job: SchedulerJob;
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
//   2. the race fulfilled  -> success, even if the parent signal aborted
//      mid-flight. A finished unit of work is recorded once; re-running it (by
//      skipping and leaving nextRunAt due) would duplicate side effects, which
//      is exactly the idempotency bug this ceiling exists to prevent. Recording
//      a real completion is always safe during graceful shutdown.
//   3. the race rejected while the controller was aborted -> skip: the task did
//      not finish, it bailed on the abort, so leave it due to run again.
//   4. the race rejected on its own -> failure.
const resolveRunOutcome = async ({
  aborted,
  db,
  job,
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

  if (!raceRejected) {
    await finishRunSuccess({ db, job, leaseToken, runId, startedAt });
    return "success";
  }

  if (aborted) {
    await finishRunSkipped({ db, job, leaseToken, runId, startedAt });
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
    "error.type": errorTag(raceError),
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

type CompleteRunOptions = {
  db: SchedulerDb;
  jobId: string;
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
  jobId,
  jobValues,
  leaseToken,
  runId,
  runValues,
}: CompleteRunOptions): Promise<void> => {
  await db.transaction(async (tx) => {
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
      .set(jobValues)
      .where(
        and(
          eq(schedulerJobs.id, jobId),
          eq(schedulerJobs.lockedBy, leaseToken),
        ),
      );
  });
};

export const finishRunSuccess = async ({
  db,
  job,
  leaseToken,
  runId,
  startedAt,
}: FinishRunOptions): Promise<void> => {
  const finishedAt = new Date();

  await completeRun({
    db,
    jobId: job.id,
    jobValues: {
      lastError: null,
      lastRunAt: startedAt,
      lastSuccessAt: finishedAt,
      lockedAt: null,
      lockedBy: null,
      lockedUntil: null,
      nextRunAt: computeNextRunAt(job.schedule, finishedAt),
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

export const finishRunSkipped = async ({
  db,
  job,
  leaseToken,
  runId,
  startedAt,
}: FinishRunOptions): Promise<void> => {
  const finishedAt = new Date();

  await completeRun({
    db,
    jobId: job.id,
    jobValues: {
      lockedAt: null,
      lockedBy: null,
      lockedUntil: null,
    },
    leaseToken,
    runId,
    runValues: {
      durationMs: durationMs(startedAt, finishedAt),
      error: "SchedulerAborted",
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
    jobId: job.id,
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
