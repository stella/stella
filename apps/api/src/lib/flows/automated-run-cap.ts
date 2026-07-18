import { and, eq, gte, sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { flowRuns, flowRunSteps } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { isAutomatedRunCapReached } from "@/api/lib/flows/flow-trigger-logic";
import type { FlowRunRows } from "@/api/lib/flows/start-flow-run";

/**
 * Atomic daily spend rail for automated (schedule / file-upload) flow runs,
 * enforcing `MAX_AUTOMATED_FLOW_RUNS_PER_DEFINITION_PER_DAY`. "Today" is the
 * current UTC calendar day; manual runs are excluded via the `triggerSource`
 * discriminator.
 *
 * The count and the insert are one atomic decision: a plain count-then-insert
 * lets two concurrent triggers (a schedule tick and a file upload) both pass the
 * check and overshoot the cap. Here a per-definition advisory transaction lock
 * serializes concurrent starts for the same definition, so the count sees every
 * committed sibling run before deciding whether to insert.
 *
 * Runs through `rootDb` (like the scheduler tasks and `processExtraction`): the
 * cap is org-wide per definition, so the count must span every workspace, which
 * an RLS-scoped, single-workspace session could not see. The run's
 * `workspace_id` still comes from a server-validated trigger source.
 */

/**
 * Namespace for the per-definition advisory lock. `pg_advisory_xact_lock` keys
 * are process-global, so a fixed first key isolates this rail from unrelated
 * advisory locks; the definition-id hash is the second key.
 */
const FLOW_RUN_CAP_LOCK_NAMESPACE = 0x0f_10_cc_a9;

const startOfUtcDay = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

export type InsertAutomatedFlowRunWithinCapInput = {
  definitionId: SafeId<"flowDefinition">;
  /** Pre-built run + step rows (see `buildFlowRunRows`). */
  rows: FlowRunRows;
  now?: Date;
};

/**
 * Outcome of the gated insert. `capped` carries the observed count so the
 * caller can surface it exactly like the previous best-effort guard did; the
 * insert simply did not happen. The caller already holds the run id it built
 * the rows with, so `started` need not echo it back.
 */
export type InsertAutomatedFlowRunWithinCapResult =
  | { outcome: "started" }
  | { outcome: "capped"; dailyRunCount: number };

export const insertAutomatedFlowRunWithinCap = async ({
  definitionId,
  rows,
  now = new Date(),
}: InsertAutomatedFlowRunWithinCapInput): Promise<InsertAutomatedFlowRunWithinCapResult> =>
  await rootDb.transaction(async (tx) => {
    // Serialize concurrent automated starts for this definition. The xact lock
    // releases on commit/rollback, after the prior holder's run row is visible,
    // so the count below can never miss a committed sibling.
    await tx.execute(
      sql`select pg_advisory_xact_lock(${FLOW_RUN_CAP_LOCK_NAMESPACE}, hashtext(${definitionId}))`,
    );

    const dailyRunCount = await tx.$count(
      flowRuns,
      and(
        eq(flowRuns.definitionId, definitionId),
        gte(flowRuns.createdAt, startOfUtcDay(now)),
        sql`${flowRuns.triggerSource}->>'type' in ('schedule', 'file-upload')`,
      ),
    );
    if (isAutomatedRunCapReached(dailyRunCount)) {
      return { outcome: "capped", dailyRunCount };
    }

    await tx.insert(flowRuns).values(rows.run);
    await tx.insert(flowRunSteps).values(rows.steps);
    return { outcome: "started" };
  });
