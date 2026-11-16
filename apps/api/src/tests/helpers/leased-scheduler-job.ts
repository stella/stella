import type { SchedulerJob } from "@/api/lib/scheduler/types";

type LeasedSchedulerJobFixtureOptions = {
  id: string;
  task: string;
  nextRunAt: Date;
  payload?: SchedulerJob["payload"];
  lockedBy?: string;
};

/** A complete scheduler row after the runner has acquired its lease. */
export const createLeasedSchedulerJobFixture = ({
  id,
  task,
  nextRunAt,
  payload = null,
  lockedBy = "test-scheduler-lease",
}: LeasedSchedulerJobFixtureOptions): SchedulerJob => ({
  id,
  task,
  description: null,
  schedule: { type: "interval", everyMs: 60_000 },
  payload,
  enabled: true,
  pausedBy: null,
  pausedSince: null,
  pausedUntil: null,
  pauseReason: null,
  nextRunAt,
  lastRunAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
  lockedAt: nextRunAt,
  lockedUntil: new Date(nextRunAt.getTime() + 60_000),
  lockedBy,
  createdAt: nextRunAt,
  updatedAt: nextRunAt,
});
