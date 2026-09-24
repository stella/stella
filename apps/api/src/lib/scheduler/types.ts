import type { rootDb } from "@/api/db/root";
import type { SchedulerPayload, schedulerJobs } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { logger } from "@/api/lib/observability/logger";

export type SchedulerJob = typeof schedulerJobs.$inferSelect;

/**
 * The scheduler's database handle. The runner owns the postgres-role
 * connection and hands it to every task, so no task imports it; tests inject
 * a structurally equivalent handle.
 */
export type SchedulerDb = typeof rootDb;

export type SchedulerTaskContext = {
  db: SchedulerDb;
  job: SchedulerJob;
  payload: SchedulerPayload | null;
  runId: SafeId<"schedulerJobRun">;
  scheduleContinuation: (nextRunAt: Date) => void;
  signal: AbortSignal;
  logger: typeof logger;
};

export type SchedulerTask = (
  context: SchedulerTaskContext,
) => Promise<void> | void;

export type SchedulerTaskRegistry = ReadonlyMap<string, SchedulerTask>;
