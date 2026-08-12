import { reconcileOrphanedFlowRuns } from "@/api/lib/flows/flow-run-worker";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const RECONCILE_FLOW_RUN_ORPHANS_TASK =
  "flows.reconcileOrphanRuns" as const;

/**
 * How long a `pending`/`running` run may sit before its step job counts as
 * lost. It has to outlast one step's legitimate worst case: the 4-minute
 * per-job timeout, both BullMQ attempts, and the backoff between them.
 */
const STALL_WINDOW_MS = 15 * 60 * 1000;

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
  logger,
  signal,
}) => {
  if (signal.aborted) {
    return;
  }

  // audit: skip — re-drives derived queue state; scheduler_job_runs is the
  // durable execution trail.
  await reconcileOrphanedFlowRuns({
    signal,
    stalledBefore: new Date(Date.now() - STALL_WINDOW_MS),
  });

  logger.debug("scheduler.flow_run_orphans_reconciled");
};
