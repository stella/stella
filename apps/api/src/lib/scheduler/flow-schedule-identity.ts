import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

/**
 * Scheduler task backing a definition's `schedule` trigger. One
 * `scheduler_jobs` row per schedule-triggered definition (see
 * `syncFlowScheduleTriggerInTransaction`) fires this daily at the trigger's UTC hour; the
 * task gates weekly / monthly frequencies to the day of the slot that was due, revalidates the
 * definition + target workspace, then defers to `startAutomatedFlowRun` (actor
 * guarantee + daily cap + run start).
 */
export const FLOW_RUN_TASK = "flow.run" as const;

/** Deterministic scheduler-job id so one definition owns at most one row. */
const FLOW_SCHEDULE_JOB_PREFIX = `${FLOW_RUN_TASK}.`;
export const flowScheduleJobId = (definitionId: string): string =>
  `${FLOW_SCHEDULE_JOB_PREFIX}${definitionId}`;

export const flowScheduleJobIdSql = (definitionId: SQLWrapper) =>
  sql`${FLOW_SCHEDULE_JOB_PREFIX} || (${definitionId})::text`;
