/**
 * Read the record card for Czech Constitutional Court decisions stored before
 * the adapter fetched one, and write the judges it states onto them.
 *
 *   # one bounded pass, nálezy first
 *   bun run src/scripts/backfill-cz-us-judges.ts
 *
 *   # a smaller pass, to see what a run does before spending the budget
 *   bun run src/scripts/backfill-cz-us-judges.ts --budget=50
 *
 * Restarts resume: a decision whose card has been read says so on the row and
 * is not asked about again. Run it until a pass reports `source-exhausted`.
 *
 * Not a scheduled job and not a migration: it spends the publisher's request
 * budget, so it runs under an operator who reads the report.
 */

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import { runCzUsJudgesBackfill } from "@/api/handlers/case-law/ingestion/cz-us-judges-backfill";
import { runCaseLawSourceBackfill } from "@/api/scripts/case-law-source-backfill";

await runCaseLawSourceBackfill({
  adapterKey: ADAPTER_KEYS.CZ_US,
  argv: process.argv.slice(2),
  run: async ({ requestBudget, ...source }) =>
    await runCzUsJudgesBackfill({
      ...source,
      ...(requestBudget === undefined ? {} : { requestBudget }),
    }),
});
