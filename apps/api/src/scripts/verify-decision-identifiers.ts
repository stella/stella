import { runScriptWithErrorOutput } from "@stll/errors/script-error";

import { verifyDecisionIdentifierBackfill } from "@/api/handlers/case-law/ingestion/decision-identifier-backfill";
import { openCaseLawReadOnlySession } from "@/api/lib/case-law/maintenance-lane";

/** Read-only cutover receipt after the scheduled identifier pass and resolver drain. */
await runScriptWithErrorOutput(async () => {
  const { rootDb } = await openCaseLawReadOnlySession();
  const verification = await verifyDecisionIdentifierBackfill(rootDb);
  await Bun.write(Bun.stdout, `${JSON.stringify(verification, null, 2)}\n`);
  // The read-only handle borrows global Bun SQL pools; this one-shot command
  // exits after its receipt rather than leaving idle pool connections alive.
  process.exit(verification.status === "ready-for-cutover" ? 0 : 2);
});
