import { Result } from "better-result";
import { eq, type InferSelectModel } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import type { flowDefinitions } from "@/api/db/schema";
import { schedulerJobs } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics";
import { errorTag } from "@/api/lib/errors/utils";
import { flowScheduleToSchedulerSchedule } from "@/api/lib/flows/flow-trigger-logic";
import { logger } from "@/api/lib/observability/logger";
import { ensureSchedulerJob } from "@/api/lib/scheduler/jobs";
import {
  FLOW_RUN_TASK,
  flowScheduleJobId,
} from "@/api/lib/scheduler/tasks/flow-run";

type FlowDefinitionRow = InferSelectModel<typeof flowDefinitions>;

/**
 * Reconcile the scheduler row for a definition's `schedule` trigger. Called
 * from the create / update / delete definition handlers after the write
 * commits, so exactly one `scheduler_jobs` row (task `flow.run`, keyed by
 * `flowScheduleJobId`) exists per enabled schedule-triggered definition:
 *
 * - enabled + `schedule` trigger -> upsert the row (idempotent).
 * - disabled, deleted, or trigger changed away from `schedule` -> remove it.
 *
 * A post-commit background reconcile: it never throws (a failure would only
 * mean the schedule row is briefly stale until the next write); errors are
 * captured through the structured logger, not surfaced to the caller.
 */
export const syncFlowScheduleTrigger = async ({
  id,
  trigger,
  enabled,
}: Pick<FlowDefinitionRow, "id" | "trigger" | "enabled">): Promise<void> => {
  const result = await Result.tryPromise({
    try: async () => {
      if (enabled && trigger.type === "schedule") {
        await ensureSchedulerJob({
          id: flowScheduleJobId(id),
          task: FLOW_RUN_TASK,
          description: `Scheduled flow run for definition ${id}`,
          schedule: flowScheduleToSchedulerSchedule(trigger.schedule),
          payload: { definitionId: id },
        });
        return;
      }
      await rootDb
        .delete(schedulerJobs)
        .where(eq(schedulerJobs.id, flowScheduleJobId(id)));
    },
    catch: (cause) => cause,
  });

  if (Result.isError(result)) {
    captureError(result.error, { definitionId: id });
    logger.error("flow.schedule_sync_failed", {
      definitionId: id,
      triggerType: trigger.type,
      enabled,
      "error.type": errorTag(result.error),
    });
  }
};
