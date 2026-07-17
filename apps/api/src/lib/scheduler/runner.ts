import { panic } from "better-result";
import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { schedulerJobRuns, schedulerJobs } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
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
const MIN_LEASE_MS = 3 * DEFAULT_POLL_INTERVAL_MS;

// Hard upper bound on how long a single task may run. The lease heartbeat
// renews `lockedUntil` indefinitely, so without this ceiling a task that never
// resolves would block the sequential runner AND keep the lease fresh forever,
// defeating the self-heal the lease exists for. Set to one lease period: a job
// that has not finished within a full lease is treated as hung. A JS promise
// cannot be cancelled, so the ceiling stops the heartbeat and releases the job
// rather than truly aborting the task.
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
  registry?: SchedulerTaskRegistry;
  signal?: AbortSignal;
};

type RunSchedulerOnceResult = {
  acquired: number;
  failed: number;
  skipped: number;
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
  registry = createSchedulerTaskRegistry(),
  runnerId = defaultRunnerId(),
  signal,
}: RunSchedulerOnceOptions = {}): Promise<RunSchedulerOnceResult> => {
  if (!Number.isInteger(maxRuntimeMs) || maxRuntimeMs < 1) {
    return panic("Scheduler job runtime ceiling must be a positive integer");
  }

  const jobs = await acquireDueJobs({ db, leaseMs, limit, runnerId });
  const result: RunSchedulerOnceResult = {
    acquired: jobs.length,
    failed: 0,
    skipped: 0,
    succeeded: 0,
  };
  if (jobs.length === 0) {
    return result;
  }

  const unstartedJobIds = new Set(jobs.map((job) => job.id));
  const unstartedHeartbeat = startUnstartedJobsHeartbeat({
    db,
    jobIds: unstartedJobIds,
    leaseMs,
    runnerId,
    signal,
  });

  try {
    for (const [index, job] of jobs.entries()) {
      if (signal?.aborted) {
        const unstartedJobs = jobs.slice(index);
        // oxlint-disable-next-line no-await-in-loop -- runs once before the break on abort; jobs are drained sequentially
        await releaseUnstartedJobs({
          db,
          jobs: unstartedJobs,
          runnerId,
        });
        result.skipped += unstartedJobs.length;
        break;
      }

      // oxlint-disable-next-line no-await-in-loop -- jobs run sequentially; lease renewal must precede this job's run
      const leasedJob = await renewJobLeaseBeforeStart({
        db,
        job,
        leaseMs,
        runnerId,
      });
      unstartedJobIds.delete(job.id);
      if (!leasedJob) {
        result.skipped += 1;
        continue;
      }

      // oxlint-disable-next-line no-await-in-loop -- scheduler runs leased jobs one at a time, in order, honouring the abort signal
      const status = await runJob({
        db,
        job: leasedJob,
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
  } finally {
    unstartedHeartbeat.stop();
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

      void runTick();
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

    void runTick();
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

type AcquireDueJobsOptions = {
  db: SchedulerDb;
  runnerId: string;
  limit: number;
  leaseMs: number;
};

export const acquireDueJobs = async ({
  db,
  leaseMs,
  limit,
  runnerId,
}: AcquireDueJobsOptions): Promise<SchedulerJob[]> => {
  if (!Number.isInteger(limit) || limit < 1) {
    return panic("Scheduler job limit must be a positive integer");
  }

  if (!Number.isInteger(leaseMs) || leaseMs < MIN_LEASE_MS) {
    return panic("Scheduler lease must be at least three poll intervals");
  }

  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);
  const candidates = await db
    .select()
    .from(schedulerJobs)
    .where(dueJobPredicate(now))
    .orderBy(asc(schedulerJobs.nextRunAt), asc(schedulerJobs.id))
    .limit(limit);
  const acquired: SchedulerJob[] = [];

  for (const candidate of candidates) {
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop, no-await-in-loop -- sequential conditional locking preserves due-order acquisition
    const [job] = await db
      .update(schedulerJobs)
      .set({
        lockedAt: now,
        lockedBy: runnerId,
        lockedUntil: leaseExpiresAt,
      })
      .where(and(eq(schedulerJobs.id, candidate.id), dueJobPredicate(now)))
      .returning();

    if (job) {
      acquired.push(job);
    }
  }

  return acquired;
};

type ReleaseUnstartedJobsOptions = {
  db: SchedulerDb;
  jobs: SchedulerJob[];
  runnerId: string;
};

const releaseUnstartedJobs = async ({
  db,
  jobs,
  runnerId,
}: ReleaseUnstartedJobsOptions): Promise<void> => {
  if (jobs.length === 0) {
    return;
  }

  await db
    .update(schedulerJobs)
    .set({
      lockedAt: null,
      lockedBy: null,
      lockedUntil: null,
    })
    .where(
      and(
        eq(schedulerJobs.lockedBy, runnerId),
        inArray(
          schedulerJobs.id,
          jobs.map((job) => job.id),
        ),
      ),
    );
};

type RenewJobLeaseBeforeStartOptions = {
  db: SchedulerDb;
  job: SchedulerJob;
  leaseMs: number;
  runnerId: string;
};

const renewJobLeaseBeforeStart = async ({
  db,
  job,
  leaseMs,
  runnerId,
}: RenewJobLeaseBeforeStartOptions): Promise<SchedulerJob | null> => {
  const now = new Date();
  const [leasedJob] = await db
    .update(schedulerJobs)
    .set({
      lockedAt: now,
      lockedBy: runnerId,
      lockedUntil: new Date(now.getTime() + leaseMs),
    })
    .where(
      and(eq(schedulerJobs.id, job.id), eq(schedulerJobs.lockedBy, runnerId)),
    )
    .returning();

  return leasedJob ?? null;
};

type StartUnstartedJobsHeartbeatOptions = {
  db: SchedulerDb;
  jobIds: Set<string>;
  leaseMs: number;
  runnerId: string;
  signal: AbortSignal | undefined;
};

const startUnstartedJobsHeartbeat = ({
  db,
  jobIds,
  leaseMs,
  runnerId,
  signal,
}: StartUnstartedJobsHeartbeatOptions): LeaseHeartbeat => {
  const intervalMs = Math.max(
    DEFAULT_POLL_INTERVAL_MS,
    Math.floor(leaseMs / 3),
  );

  const renew = async () => {
    if (signal?.aborted || jobIds.size === 0) {
      return;
    }

    await db
      .update(schedulerJobs)
      .set({
        lockedUntil: new Date(Date.now() + leaseMs),
      })
      .where(
        and(
          eq(schedulerJobs.lockedBy, runnerId),
          inArray(schedulerJobs.id, [...jobIds]),
        ),
      );
  };

  const timer = setInterval(() => {
    void renew().catch((error: unknown) => {
      logger.warn("scheduler.unstarted_lease_heartbeat_failed", {
        "scheduler.runner_id": runnerId,
        "error.type": errorTag(error),
      });
    });
  }, intervalMs);

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
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
  runnerId: string;
  signal: AbortSignal;
};

const startLeaseHeartbeat = ({
  db,
  jobId,
  leaseMs,
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
        and(eq(schedulerJobs.id, jobId), eq(schedulerJobs.lockedBy, runnerId)),
      );
  };

  const timer = setInterval(() => {
    void renew().catch((error: unknown) => {
      logger.warn("scheduler.lease_heartbeat_failed", {
        "scheduler.job_id": jobId,
        "scheduler.runner_id": runnerId,
        "error.type": errorTag(error),
      });
    });
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
  const startedAt = new Date();
  const runId = await createRun({ db, job, runnerId, startedAt });
  const controller = new AbortController();
  const abortListener = () => controller.abort();
  signal?.addEventListener("abort", abortListener, { once: true });
  const heartbeat = startLeaseHeartbeat({
    db,
    jobId: job.id,
    leaseMs,
    runnerId,
    signal: controller.signal,
  });
  const task = registry.get(job.task);
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

  try {
    if (!task) {
      throw new ConfigurationError({
        message: `No scheduler task registered for ${job.task}`,
      });
    }

    // Bound the task's runtime. A JS promise cannot be cancelled, so on timeout
    // the losing task promise keeps running as a "zombie". We never chain a
    // completion write onto it, and the guarded completion writes below reject
    // a late write anyway, so a zombie can never overwrite the timed-out state.
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutTimer = setTimeout(() => {
        reject(
          new SchedulerJobTimeoutError({
            jobId: job.id,
            message: `Scheduler job ${job.id} exceeded its ${maxRuntimeMs}ms runtime ceiling`,
            timeoutMs: maxRuntimeMs,
          }),
        );
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
    await finishRunSuccess({ db, job, runId, runnerId, startedAt });
    return "success";
  } catch (error: unknown) {
    if (controller.signal.aborted) {
      await finishRunSkipped({ db, job, runId, runnerId, startedAt });
      return "skipped";
    }

    if (error instanceof SchedulerJobTimeoutError) {
      // Stop heartbeating first so the released lease cannot be re-extended,
      // then release the job and mark the run timed out. Another runner can
      // now reclaim it once the (already-released) lease is past.
      heartbeat.stop();
      captureError(error, {
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
      await finishRunFailure({ db, error, job, runId, runnerId, startedAt });
      return "failed";
    }

    captureError(error, {
      schedulerJobId: job.id,
      schedulerRunId: runId,
      schedulerTask: job.task,
    });
    logger.error("scheduler.job_failed", {
      "scheduler.job_id": job.id,
      "scheduler.run_id": runId,
      "scheduler.runner_id": runnerId,
      "scheduler.task": job.task,
      "error.type": errorTag(error),
    });
    await finishRunFailure({ db, error, job, runId, runnerId, startedAt });
    return "failed";
  } finally {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
    signal?.removeEventListener("abort", abortListener);
    heartbeat.stop();
  }
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
  runId: SafeId<"schedulerJobRun">;
  runnerId: string;
  startedAt: Date;
};

// A run terminates exactly once. Guarding the run-row write on
// `status = "running"` (a generation check) plus the job-row write on
// `lockedBy = runnerId` (a lease-token check) means a late zombie completion
// can never overwrite a timed-out or reclaimed job with a stale success.
export const finishRunSuccess = async ({
  db,
  job,
  runId,
  runnerId,
  startedAt,
}: FinishRunOptions): Promise<void> => {
  const finishedAt = new Date();

  await db
    .update(schedulerJobRuns)
    .set({
      durationMs: durationMs(startedAt, finishedAt),
      finishedAt,
      status: "success",
    })
    .where(
      and(
        eq(schedulerJobRuns.id, runId),
        eq(schedulerJobRuns.status, "running"),
      ),
    );

  await db
    .update(schedulerJobs)
    .set({
      lastError: null,
      lastRunAt: startedAt,
      lastSuccessAt: finishedAt,
      lockedAt: null,
      lockedBy: null,
      lockedUntil: null,
      nextRunAt: computeNextRunAt(job.schedule, finishedAt),
    })
    .where(
      and(eq(schedulerJobs.id, job.id), eq(schedulerJobs.lockedBy, runnerId)),
    );
};

const finishRunSkipped = async ({
  db,
  job,
  runId,
  runnerId,
  startedAt,
}: FinishRunOptions): Promise<void> => {
  const finishedAt = new Date();

  await db
    .update(schedulerJobRuns)
    .set({
      durationMs: durationMs(startedAt, finishedAt),
      error: "SchedulerAborted",
      finishedAt,
      status: "skipped",
    })
    .where(
      and(
        eq(schedulerJobRuns.id, runId),
        eq(schedulerJobRuns.status, "running"),
      ),
    );

  await db
    .update(schedulerJobs)
    .set({
      lockedAt: null,
      lockedBy: null,
      lockedUntil: null,
    })
    .where(
      and(eq(schedulerJobs.id, job.id), eq(schedulerJobs.lockedBy, runnerId)),
    );
};

type FinishRunFailureOptions = FinishRunOptions & {
  error: unknown;
};

const finishRunFailure = async ({
  db,
  error,
  job,
  runId,
  runnerId,
  startedAt,
}: FinishRunFailureOptions): Promise<void> => {
  const finishedAt = new Date();
  const sanitizedError = errorTag(error);

  await db
    .update(schedulerJobRuns)
    .set({
      durationMs: durationMs(startedAt, finishedAt),
      error: sanitizedError,
      finishedAt,
      status: "failed",
    })
    .where(
      and(
        eq(schedulerJobRuns.id, runId),
        eq(schedulerJobRuns.status, "running"),
      ),
    );

  await db
    .update(schedulerJobs)
    .set({
      lastError: sanitizedError,
      lastFailureAt: finishedAt,
      lastRunAt: startedAt,
      lockedAt: null,
      lockedBy: null,
      lockedUntil: null,
      nextRunAt: computeNextRunAt(job.schedule, finishedAt),
    })
    .where(
      and(eq(schedulerJobs.id, job.id), eq(schedulerJobs.lockedBy, runnerId)),
    );
};

const durationMs = (startedAt: Date, finishedAt: Date): number =>
  Math.max(0, finishedAt.getTime() - startedAt.getTime());

const defaultRunnerId = (): string => {
  const host = process.env["HOSTNAME"] ?? "local";
  return `${host}:${process.pid}:${Bun.randomUUIDv7()}`;
};
