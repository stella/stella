import { and, gt, isNull, lt, or, sql } from "drizzle-orm";

import { schedulerJobs } from "@/api/db/schema";
import { readBounded } from "@/api/lib/db/read-bounded";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const AUDIT_SCHEDULER_PAUSES_TASK = "scheduler.auditPauses" as const;

/** Overdue pauses logged one by one per run; more is a single overflow event. */
export const PAUSE_AUDIT_LOG_LIMIT = 100;

export const auditSchedulerPauses: SchedulerTask = async ({ db, logger }) => {
  const overdue = await readBounded(
    db
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
      ),
    PAUSE_AUDIT_LOG_LIMIT,
  );

  if (overdue.type === "overflow") {
    logger.error("scheduler.job.pause_overdue_overflow", {
      cap: overdue.cap,
    });
    return;
  }
  for (const pause of overdue.rows) {
    logger.error("scheduler.job.pause_overdue", {
      jobId: pause.id,
      pausedBy: pause.pausedBy,
      pauseReason: pause.pauseReason,
      pausedSince: pause.pausedSince,
      pausedUntil: pause.pausedUntil,
    });
  }
};
