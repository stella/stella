import { and, gt, isNull, lt, or, sql } from "drizzle-orm";

import { schedulerJobs } from "@/api/db/schema";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const AUDIT_SCHEDULER_PAUSES_TASK = "scheduler.auditPauses" as const;

/** Overdue pauses logged per run, oldest first; more is one more event. */
export const PAUSE_AUDIT_LOG_LIMIT = 100;

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
    )
    // A pause without a recorded start is the oldest kind.
    .orderBy(
      sql`${schedulerJobs.pausedSince} ASC NULLS FIRST`,
      schedulerJobs.id,
    )
    .limit(PAUSE_AUDIT_LOG_LIMIT + 1);

  if (overduePauses.length > PAUSE_AUDIT_LOG_LIMIT) {
    logger.error("scheduler.job.pause_overdue_truncated", {
      logged: PAUSE_AUDIT_LOG_LIMIT,
    });
  }
  for (const pause of overduePauses.slice(0, PAUSE_AUDIT_LOG_LIMIT)) {
    logger.error("scheduler.job.pause_overdue", {
      jobId: pause.id,
      pausedBy: pause.pausedBy,
      pauseReason: pause.pauseReason,
      pausedSince: pause.pausedSince,
      pausedUntil: pause.pausedUntil,
    });
  }
};
