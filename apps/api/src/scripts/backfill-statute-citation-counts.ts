/**
 * Repair exact statute and provision citation counts from the canonical
 * provision-citation table. Progress is durable in the count-state row;
 * Decision locks and membership triggers keep completed ranges current while the
 * source writer continues to run.
 */
import { createStatuteCitationCountRepair } from "@/api/handlers/case-law/provisions/citation-count-repair";
import { enterCaseLawMaintenanceLane } from "@/api/lib/case-law/maintenance-lane";

const { rootDb } = await enterCaseLawMaintenanceLane();

const repairBatch = createStatuteCitationCountRepair(rootDb);
let repairedDecisions = 0;

while (true) {
  const batch = await repairBatch();
  repairedDecisions += batch.decisions;
  if (batch.status === "ready") {
    break;
  }
}

console.info(`Repaired citation counts from ${repairedDecisions} decisions.`);
process.exit(0);
