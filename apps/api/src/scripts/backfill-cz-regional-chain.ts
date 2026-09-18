/**
 * Read the later decisions affecting each stored Czech regional-court
 * decision, and write them onto the row.
 *
 *   # one bounded pass
 *   bun run src/scripts/backfill-cz-regional-chain.ts
 *
 *   # a smaller pass, to see what a run does before spending the budget
 *   bun run src/scripts/backfill-cz-regional-chain.ts --budget=50
 *
 * Restarts resume: a row whose chain has been read says so on the row and is
 * not asked about again. Run it until a pass reports `source-exhausted`.
 *
 * Not a scheduled job and not a migration: it spends one publisher request
 * per decision, so it runs under an operator who reads the report.
 */

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import { runCzRegionalChainBackfill } from "@/api/handlers/case-law/ingestion/cz-regional-chain-backfill";
import { runCaseLawSourceBackfill } from "@/api/scripts/case-law-source-backfill";

await runCaseLawSourceBackfill({
  adapterKey: ADAPTER_KEYS.CZ_REGIONAL,
  argv: process.argv.slice(2),
  run: async ({ requestBudget, ...source }) =>
    await runCzRegionalChainBackfill({
      ...source,
      ...(requestBudget === undefined ? {} : { requestBudget }),
    }),
});
