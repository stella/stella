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
 * A doc mapping is fixed when an index is created, so a layout change (case
 * law now emits one document per passage) only takes effect in indexes built
 * fresh: pass a new generation prefix rather than re-running into the current
 * one, where the passage fields would be dropped on ingest.
 *
 * Optional pacing: when the CORPUS_INDEX_BACKPRESSURE_* env group is set,
 * the loop samples the configured CloudWatch metric between batches and
 * pauses below the low watermark until the value recovers above the high
 * watermark (see lib/corpus-index/backfill-pacing.ts). It also emits a
 * periodic progress heartbeat through the structured logger.
 *
 *   CORPUS_INDEX_ENDPOINT=... CORPUS_STORAGE_MODE=dual-write \
 *     bun run src/scripts/build-corpus-index.ts [generation]
 */
import { panic } from "better-result";

import { envBase } from "@/api/env-base";
import { backfillCorpusIndexGenerationPage } from "@/api/handlers/case-law/corpus-index";
import { enterCaseLawMaintenanceLane } from "@/api/lib/case-law/maintenance-lane";
import {
  createBackfillPacer,
  createCloudWatchBackpressureSampler,
  resolveBackpressureConfig,
} from "@/api/lib/corpus-index/backfill-pacing";
import { CorpusIndexError } from "@/api/lib/legal-search/corpus-index-client";
import { LIMITS } from "@/api/lib/limits";
import { refreshCorpusS3, refreshS3 } from "@/api/lib/s3";

// Hold the maintenance lane before the first statement: operator passes over
// the case-law tables serialize here instead of deadlocking on row locks.
const { ingestionDb } = await enterCaseLawMaintenanceLane();

const generation = process.argv[2] ?? envBase.LEGAL_SEARCH_INDEX_GENERATION;

await refreshS3();
await refreshCorpusS3();

const backpressureConfig = resolveBackpressureConfig(envBase);
const pacer = createBackfillPacer({
  generation,
  backpressure:
    backpressureConfig === null
      ? null
      : {
          config: backpressureConfig,
          sample: createCloudWatchBackpressureSampler(backpressureConfig),
        },
});

console.log(`=== BUILD CORPUS INDEX: generation ${generation} ===`);

let total = 0;
while (true) {
  await pacer.beforeBatch();
  // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- durable page walk: each page's cursor comes from the previous page's commit
  const result = await backfillCorpusIndexGenerationPage(
    ingestionDb,
    LIMITS.corpusIndexBatchSize,
    generation,
  );
  switch (result.status) {
    case "complete":
      break;
    case "busy":
      throw new CorpusIndexError({
        message: `generation backfill ${generation} is already leased by another worker`,
      });
    case "advanced":
      total += result.indexed;
      pacer.recordBatch(result.indexed);
      console.log(`  indexed ${total}...`);
      continue;
    default:
      result satisfies never;
      panic(`Unhandled result: ${String(result)}`);
  }
  break;
}

pacer.finish();
console.log(`Done. Indexed ${total} decisions for generation ${generation}.`);

process.exit(0);
