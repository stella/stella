import type { SchedulerPayload, schedulerJobs } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { logger } from "@/api/lib/observability/logger";

export type SchedulerJob = typeof schedulerJobs.$inferSelect;

export type SchedulerTaskContext = {
  job: SchedulerJob;
  payload: SchedulerPayload | null;
  runId: SafeId<"schedulerJobRun">;
  signal: AbortSignal;
  logger: typeof logger;
};

export type SchedulerTask = (
  context: SchedulerTaskContext,
) => Promise<void> | void;

export type SchedulerTaskRegistry = ReadonlyMap<string, SchedulerTask>;
