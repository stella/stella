import type { ProvisionBackfillStep } from "./step";
import { inBackfillTransaction, PROVISION_BACKFILL_BUDGET } from "./step";

const BATCH_SIZE = 1000;
const PAGE_BUDGET = { lockTimeout: 1000, statementTimeout: 5000 };

/**
 * Migration-era debt retains its existing due_at as the pending-age baseline,
 * including blocked and delayed work. Each committed batch removes its rows
 * from the clock-seed partial index, which is the durable resume checkpoint.
 * New writes maintain the clock through the migration's trigger.
 */
export const PROVISION_PENDING_CLOCK_STEP: ProvisionBackfillStep = {
  name: "pending-clock",
  budget: PROVISION_BACKFILL_BUDGET.PAGE,
  readCompletion: async (connection) => {
    const rows = await connection.query(
      `SELECT 1 FROM case_law_provision_extractions
       WHERE due_at IS NOT NULL AND pending_since IS NULL LIMIT 1`,
    );
    return rows.length === 0
      ? { type: "complete" }
      : { type: "incomplete", reason: "pending clocks are not initialized" };
  },
  advance: async (connection) =>
    await inBackfillTransaction(connection, PAGE_BUDGET, async () => {
      await connection.execute(
        `WITH batch AS (
           SELECT decision_id FROM case_law_provision_extractions
           WHERE due_at IS NOT NULL AND pending_since IS NULL
           ORDER BY decision_id LIMIT ${BATCH_SIZE}
         )
         UPDATE case_law_provision_extractions AS state
         SET pending_since = state.due_at
         FROM batch WHERE state.decision_id = batch.decision_id
           AND state.due_at IS NOT NULL AND state.pending_since IS NULL`,
      );
    }),
};
