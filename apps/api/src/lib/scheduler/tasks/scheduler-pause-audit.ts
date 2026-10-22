import { and, gt, isNull, lt, or, sql } from "drizzle-orm";

import { schedulerJobs } from "@/api/db/schema";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const AUDIT_SCHEDULER_PAUSES_TASK = "scheduler.auditPauses" as const;

export const auditSchedulerPauses: SchedulerTask = async ({ db, logger }) => {
  const overduePauses = await db
    .select({
      id: schedulerJobs.id,
      pausedBy: schedulerJobs.pausedBy,
      pauseReason: schedulerJobs.pauseReason,
      pausedSince: schedulerJobs.pausedSince,
      pausedUntil: schedulerJobs.pausedUntil,
    })
    .from(schedulerJobs)
    .where(
      and(
        gt(schedulerJobs.pausedUntil, sql`now()`),
        or(
          lt(schedulerJobs.pausedSince, sql`now() - interval '24 hours'`),
          isNull(schedulerJobs.pausedSince),
        ),
      ),
    );

  for (const pause of overduePauses) {
    logger.error("scheduler.job.pause_overdue", {
      jobId: pause.id,
      pausedBy: pause.pausedBy,
      pauseReason: pause.pauseReason,
      pausedSince: pause.pausedSince,
      pausedUntil: pause.pausedUntil,
    });
  }
};
