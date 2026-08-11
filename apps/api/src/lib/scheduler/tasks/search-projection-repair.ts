import type { SchedulerTask } from "@/api/lib/scheduler/types";
import { reconcileSearchProjections } from "@/api/lib/search/reconcile-projections";

export const REPAIR_SEARCH_PROJECTIONS_TASK =
  "search.repairProjections" as const;

export const repairSearchProjections: SchedulerTask = async ({
  logger,
  signal,
}) => {
  // audit: skip — scheduler repairs derived search projections;
  // scheduler_job_runs is the durable execution trail.
  const outcome = await reconcileSearchProjections({ signal });

  if (outcome.repaired === 0 && outcome.failed === 0) {
    logger.debug("search.projection_repair_clean");
    return;
  }

  logger.info("search.projection_repair_complete", {
    contacts: outcome.contacts,
    entities: outcome.entities,
    failed: outcome.failed,
    workspaces: outcome.workspaces,
  });
};
