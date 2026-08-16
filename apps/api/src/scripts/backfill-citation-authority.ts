/**
 * Materialize `citation_authority` / `citation_count` across the whole
 * case-law corpus, on demand.
 *
 * The corpus daemon keeps this fresh on a schedule; this is the operator's
 * handle on the same machinery, for seeding a corpus that has never been swept
 * or forcing the time-decayed values forward after a ranking change.
 *
 * A full sweep here means `staleBefore = now`: every decision is older than
 * that instant, so every decision is due. Each batch is one bounded statement,
 * and a recomputed decision is stamped with the current instant and drops out
 * of the set — so the walk advances by doing its work and this script can be
 * interrupted and re-run without losing or repeating any of it.
 *
 *   bun apps/api/src/scripts/backfill-citation-authority.ts
 *   bun apps/api/src/scripts/backfill-citation-authority.ts --batch 2000
 */
import { panic } from "better-result";

import { rootDb } from "@/api/db/root";
import { recomputeCitationAuthorityBatch } from "@/api/handlers/case-law/citation-authority";
import { loadCourtWeightEntriesForSql } from "@/api/handlers/case-law/court-weights";

const batchArg = process.argv.indexOf("--batch");
const BATCH =
  batchArg === -1 ? 5000 : Number(process.argv[batchArg + 1] ?? Number.NaN);
if (!Number.isInteger(BATCH) || BATCH < 1) {
  panic("--batch requires a positive integer");
}

console.log("=== BACKFILL CITATION AUTHORITY ===");

const courtWeightEntries = await loadCourtWeightEntriesForSql();
// One boundary for the whole run: a per-batch `new Date()` would keep moving
// past rows this run has already stamped, which is harmless but makes the
// progress line lie about how much is left.
const staleBefore = new Date();

let recomputed = 0;
let cited = 0;

while (true) {
  // oxlint-disable-next-line no-await-in-loop -- one bounded batch at a time; the next only starts once this one is durable
  const batch = await rootDb.transaction(
    async (tx) =>
      await recomputeCitationAuthorityBatch(tx, {
        limit: BATCH,
        staleBefore,
        courtWeightEntries,
      }),
  );
  if (batch.recomputed === 0) {
    break;
  }
  recomputed += batch.recomputed;
  cited += batch.cited;
  console.log(`  ${recomputed} decisions recomputed, ${cited} of them cited`);
}

console.log(
  `Done. ${recomputed} decisions recomputed, ${cited} carry a citation.`,
);

process.exit(0);
