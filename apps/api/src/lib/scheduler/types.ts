import { TaggedError, type Result } from "better-result";

import type { rootDb } from "@/api/db/root";
import type { SchedulerPayload, schedulerJobs } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { logger } from "@/api/lib/observability/logger";
import type { DueSlot } from "@/api/lib/scheduler/due-slot";

export type SchedulerJob = typeof schedulerJobs.$inferSelect & {
  /** An explicit one-shot run restores this operator pause before releasing its lease. */
  completionPause?: { pausedBy: string; pauseReason: string };
};

/**
 * The scheduler's database handle. The runner owns the postgres-role
 * connection and hands it to every task, so no task imports it; tests inject
 * a structurally equivalent handle.
 */
export type SchedulerDb = Omit<typeof rootDb, "$client">;

export type SchedulerTaskContext = {
  db: SchedulerDb;
  /**
   * The slot this run was due for (`job.nextRunAt`). Day, week and month
   * decisions read it instead of the wall clock, so a late claim decides
   * exactly as an on-time one would.
   */
  dueAt: DueSlot;
  job: SchedulerJob;
  payload: SchedulerPayload | null;
  runId: SafeId<"schedulerJobRun">;
  scheduleContinuation: (nextRunAt: Date) => void;
  signal: AbortSignal;
  logger: typeof logger;
};

export class SchedulerTaskFailure extends TaggedError("SchedulerTaskFailure")<{
  message: string;
  cause: unknown;
}> {}

export type SchedulerTask =
  | ((context: SchedulerTaskContext) => void)
  | ((
      context: SchedulerTaskContext,
    ) =>
      | Promise<void | Result<void, SchedulerTaskFailure>>
      | Result<void, SchedulerTaskFailure>);

export type SchedulerTaskRegistry = ReadonlyMap<string, SchedulerTask>;
