import { panic } from "better-result";
import { sql } from "drizzle-orm";

import { Temporal } from "@stll/time";

import { detached } from "@/api/lib/analytics/capture";
import { runProvisionStateBackfill } from "@/api/lib/case-law/provision-state-backfill/backfill";
import type { ProvisionBackfillSession } from "@/api/lib/case-law/provision-state-backfill/step";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import type { SchedulerTask } from "@/api/lib/scheduler/types";
import { isRecord } from "@/api/lib/type-guards";

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
  // One reserved session: every unit is BEGIN ... COMMIT on it. An abort
  // (shutdown, lease loss) cancels the statement in flight on that backend,
  // which fails and rolls back its unit; the runner starts nothing after it.
  const reserved = await db.$client.reserve();
  const backendRows: unknown = await reserved`SELECT pg_backend_pid() AS pid`;
  const backend: unknown = Array.isArray(backendRows)
    ? backendRows.at(0)
    : undefined;
  const pid = isRecord(backend) ? backend["pid"] : undefined;
  if (typeof pid !== "number") {
    reserved.release();
    panic("Expected the reserved session's PostgreSQL backend pid");
  }
  const cancelInFlight = () => {
    detached(
      db.execute(sql`SELECT pg_cancel_backend(${pid})`),
      "provision-state-backfill.cancel-statement",
    );
  };
  signal.addEventListener("abort", cancelInFlight, { once: true });
  const connection: ProvisionBackfillSession = {
    execute: async (query, params = []) => {
      await reserved.unsafe(query, [...params]);
    },
    query: async (query, params = []) => {
      const result: unknown = await reserved.unsafe(query, [...params]);
      if (!Array.isArray(result)) {
        return panic("Bun SQL returned a non-array result");
      }
      const rows: readonly unknown[] = result;
      return rows;
    },
  };
  const run = await runProvisionStateBackfill({
    connection,
    deadline: Temporal.Now.instant().epochMilliseconds + RUN_BUDGET_MS,
    signal,
  }).finally(() => {
    signal.removeEventListener("abort", cancelInFlight);
    reserved.release();
  });
  if (run.isErr()) {
    // A cancelled statement is the abort itself, not a failure; either way
    // the unit rolled back and the next run retries it from its cursor.
    if (signal.aborted) {
      logger.info("scheduler.case_law_provision_state_backfill_aborted", {});
      return;
    }
    observeFailure(run.error, { sink: backfillUnitFailed });
    return;
  }
  logger.info("scheduler.case_law_provision_state_backfill", {
    // The step still owed, "complete", "aborted", or "superseded" when a
    // newer release has applied its admission.
    "caseLawProvisionStateBackfill.pending":
      run.value.type === "progress" || run.value.type === "aborted"
        ? run.value.step
        : run.value.type,
  });
};
