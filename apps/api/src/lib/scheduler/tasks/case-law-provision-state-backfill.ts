import { Temporal } from "@stll/time";

import { runProvisionStateBackfill } from "@/api/lib/case-law/provision-state-backfill/backfill";
import type { ProvisionBackfillSession } from "@/api/lib/case-law/provision-state-backfill/step";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const BACKFILL_CASE_LAW_PROVISION_STATE_TASK =
  "caseLaw.backfillProvisionState" as const;

/**
 * Wall time one run may spend starting keyset pages. A page commits in well
 * under a second, so a run ends shortly after this; the next run resumes from
 * the committed cursors. A CHECK validation scan runs alone in its run under
 * its own statement budget.
 */
const RUN_BUDGET_MS = 5 * 60_000;

const backfillUnitFailed = failureSink({
  event: "scheduler.case_law_provision_state_backfill_failed",
  expected: [],
});

/**
 * The provision state backfill: scope rows for every decision key, the
 * profiles' scopes and their transition jobs, state for every in-scope
 * decision, then the provision-row CHECK validations. It runs here rather
 * than in the migrate phase because that phase holds the corpus schema lane
 * exclusively and would pause every corpus writer for the whole walk.
 *
 * Recurring: a finished backfill costs a handful of reads per run, and a
 * profile that gains or loses a scope in a later release is applied by the
 * next run.
 */
export const backfillCaseLawProvisionState: SchedulerTask = async ({
  db,
  logger,
  signal,
}) => {
  signal.throwIfAborted();
  // One reserved session: every unit is BEGIN ... COMMIT on it.
  const reserved = await db.$client.reserve();
  const connection: ProvisionBackfillSession = {
    execute: async (query, params = []) => {
      await reserved.unsafe(query, [...params]);
    },
    query: async (query, params = []) =>
      await reserved.unsafe(query, [...params]),
  };
  const run = await runProvisionStateBackfill({
    connection,
    deadline: Temporal.Now.instant().epochMilliseconds + RUN_BUDGET_MS,
  }).finally(() => {
    reserved.release();
  });
  // A failed unit was rolled back, so nothing is half written; the next run
  // retries it from the committed cursors.
  if (run.isErr()) {
    observeFailure(run.error, { sink: backfillUnitFailed });
    return;
  }
  logger.info("scheduler.case_law_provision_state_backfill", {
    // The step still owed, or "complete".
    "caseLawProvisionStateBackfill.pending":
      run.value.type === "progress" ? run.value.step : run.value.type,
  });
};
