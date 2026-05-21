import { panic } from "better-result";
import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { schedulerJobRuns, schedulerJobs } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics";
import type { SafeId } from "@/api/lib/branded-types";
import { ConfigurationError } from "@/api/lib/errors/tagged-errors";
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

type RunSchedulerOnceOptions = {
  runnerId?: string;
  limit?: number;
  leaseMs?: number;
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
  leaseMs = DEFAULT_LEASE_MS,
  limit = DEFAULT_JOB_LIMIT,
  registry = createSchedulerTaskRegistry(),
  runnerId = defaultRunnerId(),
  signal,
}: RunSchedulerOnceOptions = {}): Promise<RunSchedulerOnceResult> => {
  const jobs = await acquireDueJobs({ leaseMs, limit, runnerId });
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
    jobIds: unstartedJobIds,
    leaseMs,
    runnerId,
    signal,
  });

  try {
    for (const [index, job] of jobs.entries()) {
      if (signal?.aborted) {
        const unstartedJobs = jobs.slice(index);
        await releaseUnstartedJobs({
          jobs: unstartedJobs,
          runnerId,
        });
        result.skipped += unstartedJobs.length;
        break;
      }

      const leasedJob = await renewJobLeaseBeforeStart({
        job,
        leaseMs,
        runnerId,
      });
      unstartedJobIds.delete(job.id);
      if (!leasedJob) {
        result.skipped += 1;
        continue;
      }

      const status = await runJob({
        job: leasedJob,
        leaseMs,
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
  runnerId: string;
  limit: number;
  leaseMs: number;
};

const acquireDueJobs = async ({
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
  const candidates = await rootDb
    .select()
    .from(schedulerJobs)
    .where(dueJobPredicate(now))
    .orderBy(asc(schedulerJobs.nextRunAt), asc(schedulerJobs.id))
    .limit(limit);
  const acquired: SchedulerJob[] = [];

  for (const candidate of candidates) {
    const [job] = await rootDb
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
  jobs: SchedulerJob[];
  runnerId: string;
};

const releaseUnstartedJobs = async ({
  jobs,
  runnerId,
}: ReleaseUnstartedJobsOptions): Promise<void> => {
  if (jobs.length === 0) {
    return;
  }

  await rootDb
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
  job: SchedulerJob;
  leaseMs: number;
  runnerId: string;
};

const renewJobLeaseBeforeStart = async ({
  job,
  leaseMs,
  runnerId,
}: RenewJobLeaseBeforeStartOptions): Promise<SchedulerJob | null> => {
  const now = new Date();
  const [leasedJob] = await rootDb
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
  jobIds: Set<string>;
  leaseMs: number;
  runnerId: string;
  signal: AbortSignal | undefined;
};

const startUnstartedJobsHeartbeat = ({
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

    await rootDb
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
  jobId: string;
  leaseMs: number;
  runnerId: string;
  signal: AbortSignal;
};

const startLeaseHeartbeat = ({
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

    await rootDb
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
  job: SchedulerJob;
  leaseMs: number;
  runnerId: string;
  registry: SchedulerTaskRegistry;
  signal: AbortSignal | undefined;
};

type RunJobStatus = "failed" | "skipped" | "success";

const runJob = async ({
  job,
  leaseMs,
  registry,
  runnerId,
  signal,
}: RunJobOptions): Promise<RunJobStatus> => {
  const startedAt = new Date();
  const runId = await createRun({ job, runnerId, startedAt });
  const controller = new AbortController();
  const abortListener = () => controller.abort();
  signal?.addEventListener("abort", abortListener, { once: true });
  const heartbeat = startLeaseHeartbeat({
    jobId: job.id,
    leaseMs,
    runnerId,
    signal: controller.signal,
  });
  const task = registry.get(job.task);

  try {
    if (!task) {
      throw new ConfigurationError({
        message: `No scheduler task registered for ${job.task}`,
      });
    }

    await task({
      job,
      logger,
      payload: job.payload,
      runId,
      signal: controller.signal,
    });
    await finishRunSuccess({ job, runId, runnerId, startedAt });
    return "success";
  } catch (error: unknown) {
    if (controller.signal.aborted) {
      await finishRunSkipped({ job, runId, runnerId, startedAt });
      return "skipped";
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
    await finishRunFailure({ error, job, runId, runnerId, startedAt });
    return "failed";
  } finally {
    signal?.removeEventListener("abort", abortListener);
    heartbeat.stop();
  }
};

type CreateRunOptions = {
  job: SchedulerJob;
  runnerId: string;
  startedAt: Date;
};

const createRun = async ({
  job,
  runnerId,
  startedAt,
}: CreateRunOptions): Promise<SafeId<"schedulerJobRun">> => {
  const [run] = await rootDb
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
  job: SchedulerJob;
  runId: SafeId<"schedulerJobRun">;
  runnerId: string;
  startedAt: Date;
};

const finishRunSuccess = async ({
  job,
  runId,
  runnerId,
  startedAt,
}: FinishRunOptions): Promise<void> => {
  const finishedAt = new Date();

  await rootDb
    .update(schedulerJobRuns)
    .set({
      durationMs: durationMs(startedAt, finishedAt),
      finishedAt,
      status: "success",
    })
    .where(eq(schedulerJobRuns.id, runId));

  await rootDb
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
  job,
  runId,
  runnerId,
  startedAt,
}: FinishRunOptions): Promise<void> => {
  const finishedAt = new Date();

  await rootDb
    .update(schedulerJobRuns)
    .set({
      durationMs: durationMs(startedAt, finishedAt),
      error: "SchedulerAborted",
      finishedAt,
      status: "skipped",
    })
    .where(eq(schedulerJobRuns.id, runId));

  await rootDb
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
  error,
  job,
  runId,
  runnerId,
  startedAt,
}: FinishRunFailureOptions): Promise<void> => {
  const finishedAt = new Date();
  const sanitizedError = errorTag(error);

  await rootDb
    .update(schedulerJobRuns)
    .set({
      durationMs: durationMs(startedAt, finishedAt),
      error: sanitizedError,
      finishedAt,
      status: "failed",
    })
    .where(eq(schedulerJobRuns.id, runId));

  await rootDb
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
