/**
 * Heal a jurisdiction the census reported as short.
 *
 * `case_law.corpus_index.census_drift` says the engine holds fewer
 * documents than Postgres has marked indexed for one jurisdiction. Those
 * rows are invisible to the backfill: an `indexedHash` equal to the
 * content hash means neither missing nor stale, so nothing selects them
 * again and the gap never closes on its own.
 *
 * Clearing the mark is the whole repair — the row becomes missing work,
 * the ordinary backfill re-projects it through the same path as a newly
 * ingested decision, and re-ingesting a document the engine already
 * holds replaces it at the same id. Nothing is deleted, so running this
 * on a jurisdiction that was not actually short costs re-indexing and
 * nothing else.
 *
 * Bounded on purpose: a jurisdiction can be millions of rows, and
 * un-marking them all at once hands the backfill a backlog that starves
 * every newly ingested decision behind it. Each run clears one slice;
 * re-run until the census agrees.
 *
 *   CORPUS_INDEX_ENDPOINT=... \
 *     bun run src/scripts/repair-corpus-index-jurisdiction.ts SVK [limit]
 */
import { panic } from "better-result";

import { rlsDb } from "@/api/db/root";
import { createIngestionDb } from "@/api/db/scoped";
import { envBase } from "@/api/env-base";
import {
  censusJurisdiction,
  clearJurisdictionIndexMarks,
  MAX_REPAIR_SLICE,
} from "@/api/lib/corpus-index/census";
import { isCorpusIndexJurisdiction } from "@/api/lib/legal-search/index-naming";

const jurisdiction = process.argv[2];
if (jurisdiction === undefined || !isCorpusIndexJurisdiction(jurisdiction)) {
  panic("usage: repair-corpus-index-jurisdiction.ts <jurisdiction> [limit]");
}

// A mistyped digit must not turn a bounded repair into one transaction
// updating every row in the jurisdiction and firing the projection
// trigger for each of them, so the ceiling is enforced here rather than
// trusted from the argument. `clearJurisdictionIndexMarks` clamps too;
// rejecting loudly here is what tells the operator their number was
// ignored.
const limitArgument = process.argv[3];
const limit =
  limitArgument === undefined ? MAX_REPAIR_SLICE : Number(limitArgument);
if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_REPAIR_SLICE) {
  panic(
    `limit must be a positive integer no greater than ${MAX_REPAIR_SLICE}, got ${String(limit)}`,
  );
}

const generation = envBase.LEGAL_SEARCH_INDEX_GENERATION;
const ingestionDb = createIngestionDb(rlsDb);

// Reported before and after so the operator sees the shortfall the repair
// was pointed at, rather than trusting the alert that sent them here.
const before = await censusJurisdiction({
  scopedDb: ingestionDb,
  generation,
  jurisdiction,
});
if (before.isErr()) {
  panic("census failed before the repair", before.error);
}
console.log(
  `=== ${before.value.indexId}: engine ${before.value.engineDocuments}, marked ${before.value.markedIndexed}, short ${before.value.shortfall} ===`,
);

const cleared = await clearJurisdictionIndexMarks({
  scopedDb: ingestionDb,
  generation,
  jurisdiction,
  limit,
});
console.log(
  `Cleared ${cleared} index marks; the backfill will re-project them. Re-run until the census agrees.`,
);
