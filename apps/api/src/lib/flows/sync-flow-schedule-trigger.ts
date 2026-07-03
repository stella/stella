import type { InferSelectModel } from "drizzle-orm";

import type { flowDefinitions } from "@/api/db/schema";
import { logger } from "@/api/lib/observability/logger";

type FlowDefinitionRow = InferSelectModel<typeof flowDefinitions>;

/**
 * Seam for Phase 3 (schedule trigger upkeep). Called from the definition
 * create / update / delete handlers so scheduler-row synchronization has a
 * single, clearly-named hook.
 *
 * PHASE 3 IMPLEMENTS THIS. It will map a `schedule`-triggered definition to a
 * `SchedulerSchedule` and upsert a `schedulerJobs` row (task `"flow.run"`,
 * payload `{ definitionId }`) via `ensureSchedulerJob`, and disable/remove that
 * row when the definition is deleted, disabled, or its trigger is changed away
 * from `schedule`. Until then this is an intentional no-op: nothing reads flow
 * schedules yet, so leaving it unimplemented cannot produce a stray run.
 */
export const syncFlowScheduleTrigger = (
  definition: Pick<FlowDefinitionRow, "id" | "trigger" | "enabled">,
): void => {
  logger.debug("flow.schedule_sync_noop", {
    definitionId: definition.id,
    triggerType: definition.trigger.type,
    enabled: String(definition.enabled),
  });
};
