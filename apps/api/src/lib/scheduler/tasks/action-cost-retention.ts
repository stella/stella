import { env } from "@/api/env";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import type { SchedulerTask } from "@/api/lib/scheduler/types";
import {
  ACTION_COST_RETENTION_BATCH_SIZE,
  sweepActionCosts,
} from "@/api/lib/usage/action-costs/retention";

export const SWEEP_ACTION_COSTS_TASK = "actions.sweepCosts" as const;
const MAX_RETENTION_BATCHES_PER_RUN = 16;

type DrainActionCostsOptions = {
  signal: AbortSignal;
  sweep: () => ReturnType<typeof sweepActionCosts>;
  scheduleContinuation: (nextRunAt: Date) => void;
};

export const drainActionCosts = async ({
  signal,
  sweep,
  scheduleContinuation,
}: DrainActionCostsOptions) => {
  for (let batch = 0; batch < MAX_RETENTION_BATCHES_PER_RUN; batch += 1) {
    if (signal.aborted) {
      return;
    }
    const swept = await sweep();
    if (
      swept.callsDeleted < ACTION_COST_RETENTION_BATCH_SIZE &&
      swept.recordsDeleted < ACTION_COST_RETENTION_BATCH_SIZE
    ) {
      return;
    }
  }
  if (!signal.aborted) {
    scheduleContinuation(new Date());
  }
};

export const sweepActionCostRecords: SchedulerTask = async ({
  db,
  signal,
  scheduleContinuation,
}) => {
  if (
    !isDeploymentFeatureEnabled("FEATURE_ACTION_COST_RECORDS") ||
    env.ACTION_COST_RETENTION_DAYS === undefined
  ) {
    return;
  }
  const retentionDays = env.ACTION_COST_RETENTION_DAYS;
  await drainActionCosts({
    signal,
    scheduleContinuation,
    sweep: async () =>
      await sweepActionCosts({
        db,
        retentionDays,
        now: new Date(),
      }),
  });
};
