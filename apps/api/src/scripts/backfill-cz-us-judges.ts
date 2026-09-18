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

import { eq } from "drizzle-orm";

import { caseLawSources } from "@/api/db/schema";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import { runCzUsJudgesBackfill } from "@/api/handlers/case-law/ingestion/cz-us-judges-backfill";
import type { StoredRawReader } from "@/api/handlers/case-law/ingestion/replay";
import { enterCaseLawMaintenanceLane } from "@/api/lib/case-law/maintenance-lane";
import { acquireCaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { readS3ObjectIfPresent, refreshS3 } from "@/api/lib/s3";

const BUDGET_PREFIX = "--budget=";
/** A stored payload is one document; nothing here should take longer. */
const STORED_RAW_READ_TIMEOUT_MS = 30_000;

const budgetArgument = process.argv
  .slice(2)
  .find((argument) => argument.startsWith(BUDGET_PREFIX));
const requestBudget =
  budgetArgument === undefined
    ? undefined
    : Number(budgetArgument.slice(BUDGET_PREFIX.length));
if (requestBudget !== undefined && !Number.isSafeInteger(requestBudget)) {
  console.error(`${BUDGET_PREFIX}<requests> takes a whole number`);
  process.exit(1);
}

// Hold the maintenance lane before the first statement: operator passes over
// the case-law tables serialize here instead of deadlocking on row locks.
const { ingestionDb } = await enterCaseLawMaintenanceLane();
await refreshS3();

const source = (
  await ingestionDb((tx) =>
    tx
      .select({ id: caseLawSources.id, name: caseLawSources.name })
      .from(caseLawSources)
      .where(eq(caseLawSources.adapterKey, ADAPTER_KEYS.CZ_US))
      .limit(1),
  )
).at(0);

if (!source) {
  console.error(`No case-law source configured for ${ADAPTER_KEYS.CZ_US}`);
  process.exit(1);
}

// `null` only where the store confirmed it holds no such object, which is a
// durable fact about that decision. Anything else is raised: it says nothing
// about the row, and reading it as an absent payload would step over rows
// whose payloads are there.
const readStoredRaw: StoredRawReader = async (key) => {
  const bytes = await readS3ObjectIfPresent(
    key,
    AbortSignal.timeout(STORED_RAW_READ_TIMEOUT_MS),
  );
  return bytes === null ? null : new Uint8Array(bytes);
};

const sourceLease = await acquireCaseLawSourceIngestionLease({
  scopedDb: ingestionDb,
  sourceId: source.id,
});
if (sourceLease === null) {
  console.error(
    `Source ${ADAPTER_KEYS.CZ_US} is being ingested right now (lease held). Retry later.`,
  );
  process.exit(1);
}

const report = await runCzUsJudgesBackfill({
  scopedDb: ingestionDb,
  sourceId: source.id,
  sourceLease,
  readStoredRaw,
  ...(requestBudget === undefined ? {} : { requestBudget }),
});
await sourceLease.release();

console.log(JSON.stringify(report, null, 2));
process.exit(0);
