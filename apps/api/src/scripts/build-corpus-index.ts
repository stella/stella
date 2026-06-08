/**
 * Full backfill of the legal corpus into corpus index. Per-jurisdiction
 * indexes (`case_law_v1_<country>`) are created on demand by the indexer,
 * so this script just drives the backfill to completion. Used for the
 * initial build and for blue-green v2 rebuilds: pass the new generation
 * prefix; the active generation only switches when
 * LEGAL_SEARCH_INDEX_GENERATION is pointed at it (a separate config flip).
 *
 * Idempotent and re-runnable — already-indexed rows are skipped, so a
 * transient failure just means re-run.
 *
 *   CORPUS_INDEX_ENDPOINT=... CORPUS_STORAGE_ENABLED=true \
 *     bun run src/scripts/build-corpus-index.ts [generation]
 */
import { createIngestionDb } from "@/api/db";
import { rlsDb } from "@/api/db/root";
import { envBase } from "@/api/env-base";
import { backfillCorpusIndex } from "@/api/handlers/case-law/corpus-index";
import { LIMITS } from "@/api/lib/limits";
import { refreshCorpusS3, refreshS3 } from "@/api/lib/s3";

const generation = process.argv[2] ?? envBase.LEGAL_SEARCH_INDEX_GENERATION;
const ingestionDb = createIngestionDb(rlsDb);

await refreshS3();
await refreshCorpusS3();

console.log(`=== BUILD CORPUS INDEX: generation ${generation} ===`);

let total = 0;
while (true) {
  const indexed = await backfillCorpusIndex(
    ingestionDb,
    LIMITS.corpusIndexBatchSize,
    generation,
  );
  if (indexed === 0) {
    break;
  }
  total += indexed;
  console.log(`  indexed ${total}...`);
}

console.log(`Done. Indexed ${total} decisions for generation ${generation}.`);

process.exit(0);
