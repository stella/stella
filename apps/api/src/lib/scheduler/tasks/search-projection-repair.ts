import type { SchedulerTask } from "@/api/lib/scheduler/types";
import {
  createSearchProjectionRepairDeps,
  drainSearchProjectionRepairQueue,
} from "@/api/lib/search/projection-repair-queue";

export const REPAIR_SEARCH_PROJECTIONS_TASK =
  "search.repairProjections" as const;

export const repairSearchProjections: SchedulerTask = async ({
  db,
  logger,
  signal,
}) => {
  // audit: skip — scheduler repairs derived search projections;
  // scheduler_job_runs is the durable execution trail.
  const outcome = await drainSearchProjectionRepairQueue({
    deps: createSearchProjectionRepairDeps(db),
    signal,
  });

  if (outcome.repaired === 0 && outcome.failed === 0) {
    logger.debug("search.projection_repair_clean");
    return;
  }

  logger.info("search.projection_repair_complete", {
    failed: outcome.failed,
    repaired: outcome.repaired,
  });
};
