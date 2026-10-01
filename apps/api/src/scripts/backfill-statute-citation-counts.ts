/**
 * Repair exact statute and provision citation counts from the canonical
 * provision-citation table. Progress is durable in the count-state row;
 * Decision locks and membership triggers keep completed ranges current while the
 * source writer continues to run.
 */
import { createScriptBackfillRuntime } from "@/api/db/backfill-runtime";
import { createStatuteCitationCountRepair } from "@/api/handlers/case-law/provisions/citation-count-repair";
import { enterCaseLawMaintenanceLane } from "@/api/lib/case-law/maintenance-lane";

const { rootDb } = await enterCaseLawMaintenanceLane();

const runtime = await createScriptBackfillRuntime({
  db: rootDb,
  name: "statute-citation-counts",
  tableName: "case_law_decisions",
  initialSize: 500,
});
let repairedDecisions = 0;

try {
  while (true) {
    // db-await-in-loop: one gated repair transaction including its existing durable state
    const step = await runtime.step(async ({ tx, size, cursor }) => {
      const repairBatch = createStatuteCitationCountRepair({
        transaction: async (work) => await work(tx),
      });
      const batch = await repairBatch(size);
      return { cursor, done: batch.status === "ready", value: batch.decisions };
    });
    repairedDecisions += step.value;
    if (step.done) {
      break;
    }
    await Bun.sleep(step.sleepMs);
  }
} finally {
  await runtime.close();
}

console.info(`Repaired citation counts from ${repairedDecisions} decisions.`);
process.exit(0);
