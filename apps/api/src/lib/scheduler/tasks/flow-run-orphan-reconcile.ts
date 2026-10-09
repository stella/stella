import { Temporal } from "@stll/time";

import { reconcileOrphanedFlowRuns } from "@/api/lib/flows/flow-run-worker";
import { FLOW_STEP_LEASE_MS } from "@/api/lib/flows/flow-types";
import { repairFlowScheduleTriggers } from "@/api/lib/flows/sync-flow-schedule-trigger";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const RECONCILE_FLOW_RUN_ORPHANS_TASK =
  "flows.reconcileOrphanRuns" as const;

/**
 * Re-enqueue flow-run steps no queued job owns anymore.
 *
 * The worker already does this at boot, which recovers the jobs that process
 * lost. Nothing recovered the rest: a step whose enqueue failed, or whose job
 * Redis dropped, sat in `pending`/`running` until someone noticed, because a
 * run that is waiting and a run that is stuck look identical from the row.
 * Re-adding a step is idempotent (deterministic job id, and the executor
 * refuses an already-completed step), so the sweep is safe to repeat.
 */
export const reconcileFlowRunOrphans: SchedulerTask = async ({
  db,
  logger,
  signal,
}) => {
  if (signal.aborted) {
    return;
  }

  await repairFlowScheduleTriggers({ database: db, signal });

  // audit: skip — re-drives derived queue state; scheduler_job_runs is the
  // durable execution trail.
  await reconcileOrphanedFlowRuns(
    {
      signal,
      stalledBefore: new Date(
        Temporal.Now.instant().epochMilliseconds - FLOW_STEP_LEASE_MS,
      ),
    },
    { database: db },
  );

  logger.debug("scheduler.flow_run_orphans_reconciled");
};
