/**
 * Repair exact statute and provision citation counts from the canonical
 * provision-citation table. Progress is durable in the count-state row;
 * Decision locks and membership triggers keep completed ranges current while the
 * source writer continues to run.
 */
import { runBackfillPass } from "@stll/db-load-gate/backfill-pass";
import { runScriptWithErrorOutput } from "@stll/errors";

import { createScriptBackfillRuntime } from "@/api/db/backfill-runtime";
import { createStatuteCitationCountRepair } from "@/api/handlers/case-law/provisions/citation-count-repair";
import { enterCaseLawMaintenanceLane } from "@/api/lib/case-law/maintenance-lane";
import { backfillEntrypoints } from "@/api/scripts/backfill-entrypoint";

const plan = backfillEntrypoints["statute-citation-counts"]({
  args: process.argv.slice(2),
});

await runScriptWithErrorOutput(async () => {
  const { rootDb } = await enterCaseLawMaintenanceLane();

  const runtime = plan.open((options) =>
    createScriptBackfillRuntime({ ...options, db: rootDb }),
  );
  let repairedDecisions = 0;

  try {
    const pass = await runBackfillPass({
      step: async () =>
        await runtime.step(async ({ tx, size, cursor }) => {
          const repairBatch = createStatuteCitationCountRepair({
            transaction: async (work) => await work(tx),
          });
          const batch = await repairBatch(size);
          return {
            cursor,
            done: batch.status === "ready",
            value: batch.decisions,
          };
        }),
      onBatch: ({ value }) => {
        repairedDecisions += value;
      },
      sleep: Bun.sleep,
    });
    if (pass.isErr()) {
      throw pass.error;
    }
  } finally {
    await runtime.close();
  }

  console.info(`Repaired citation counts from ${repairedDecisions} decisions.`);
  process.exit(0);
});
