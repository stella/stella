import { eq } from "drizzle-orm";

import type { ScopedTransaction } from "@/api/db/safe-db";
import type { SchedulerPayload, SchedulerSchedule } from "@/api/db/schema";
import { schedulerJobs } from "@/api/db/schema";
import { writeSchedulerBookkeeping } from "@/api/lib/db/recovery-bookkeeping/scheduler";
import type { RegisteredSchedulerTaskName } from "@/api/lib/scheduler/registry";
import { computeNextRunAt } from "@/api/lib/scheduler/schedule";

export type SchedulerJobDefinition = {
  id: string;
  task: RegisteredSchedulerTaskName;
  description: string;
  schedule: SchedulerSchedule;
  payload?: SchedulerPayload | null;
  payloadUpdate?: "preserve" | "replace";
  enabled?: boolean;
};

export const schedulerSchedulesEqual = (
  left: SchedulerSchedule,
  right: SchedulerSchedule,
): boolean => {
  if (left.type !== right.type) {
    return false;
  }

  if (left.type === "interval" && right.type === "interval") {
    return left.everyMs === right.everyMs;
  }

  if (left.type !== "daily" || right.type !== "daily") {
    return false;
  }

  return (
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.timeZone === right.timeZone
  );
};

export const upsertSchedulerJob = async (
  {
    description,
    enabled = true,
    id,
    payload = null,
    payloadUpdate = "replace",
    schedule,
    task,
  }: SchedulerJobDefinition,
  db: Pick<ScopedTransaction, "select" | "insert">,
): Promise<void> => {
  const nextRunAt = computeNextRunAt(schedule);
  const [existingJob] = await db
    .select({
      schedule: schedulerJobs.schedule,
      task: schedulerJobs.task,
    })
    .from(schedulerJobs)
    .where(eq(schedulerJobs.id, id))
    .limit(1);
  const shouldRefreshNextRunAt =
    !existingJob ||
    existingJob.task !== task ||
    !schedulerSchedulesEqual(existingJob.schedule, schedule);

  await writeSchedulerBookkeeping({
    type: "upsert",
    db,
    table: schedulerJobs,
    values: { description, enabled, id, nextRunAt, payload, schedule, task },
    refreshNextRunAt: shouldRefreshNextRunAt,
    replacePayload: payloadUpdate === "replace",
  });
};
