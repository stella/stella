import { env } from "@/api/env";
import {
  ACTION_COST_RETENTION_BATCH_SIZE,
  sweepActionCosts,
} from "@/api/lib/action-costs/retention";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const SWEEP_ACTION_COSTS_TASK = "actions.sweepCosts" as const;
export const sweepActionCostRecords: SchedulerTask = async ({ db, signal }) => {
  if (
    !env.FEATURE_ACTION_COST_RECORDS ||
    env.ACTION_COST_RETENTION_DAYS === undefined
  ) {
    return;
  }
  for (let batch = 0; batch < 16 && !signal.aborted; batch += 1) {
    const swept = await sweepActionCosts({
      db,
      retentionDays: env.ACTION_COST_RETENTION_DAYS,
      now: new Date(),
    });
    if (
      swept.callsDeleted < ACTION_COST_RETENTION_BATCH_SIZE &&
      swept.recordsDeleted < ACTION_COST_RETENTION_BATCH_SIZE
    ) {
      break;
    }
  }
};
