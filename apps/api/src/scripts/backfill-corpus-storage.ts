import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";

/**
 * Backfill: copy existing canonical text/sections/AST from the Postgres
 * columns into object storage and record the keys + content hash. Run
 * once before flipping reads to corpus storage; safe to re-run (it only
 * processes rows whose `text_s3_key` is still null).
 *
 *   CORPUS_STORAGE_MODE=dual-write LEGAL_CORPUS_S3_BUCKET=... \
 *     bun run src/scripts/backfill-corpus-storage.ts
 *
 * With `--include-stale-empty` it also repairs rows whose objects were
 * written by a metadata-first ingest and never rewritten when the
 * document arrived: their columns hold the document, their keys still
 * point at the empty payload, and `text_s3_key IS NOT NULL` hides them
 * from the pass above. The empty payload's content hash identifies
 * them. Count them first with the same predicate:
 *
 *   SELECT count(*) FROM case_law_decisions
 *   WHERE text_s3_key IS NOT NULL
 *     AND fulltext IS NOT NULL AND fulltext <> ''
 *     AND content_hash IN (<EMPTY_CORPUS_CONTENT_HASHES>);
 */
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { rlsDb } from "@/api/db/root";
import { caseLawDecisions } from "@/api/db/schema";
import { createIngestionDb } from "@/api/db/scoped";
import {
  EMPTY_CORPUS_CONTENT_HASHES,
  writeCorpusDocument,
} from "@/api/handlers/case-law/corpus-storage";
import type { EmptyAst } from "@/api/handlers/case-law/ingestion/adapter";
import type { DecisionSection } from "@/api/handlers/case-law/types";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { refreshCorpusS3, refreshS3 } from "@/api/lib/s3";

const BATCH_SIZE = 50;
const CONCURRENCY = 4;

const includeStaleEmpty = process.argv.includes("--include-stale-empty");

type BackfillRow = {
  id: SafeId<"caseLawDecision">;
  country: string;
  fulltext: string | null;
  sections: DecisionSection[] | null;
  documentAst: DocumentAst | EmptyAst | null;
  contentHash: string | null;
  updatedAt: Date;
};

/** Never written to object storage. */
const missingCorpusObjects = isNull(caseLawDecisions.textS3Key);

/**
 * Written by a metadata-first ingest and never rewritten: the columns
 * hold a document, the keys still point at the empty payload the ingest
 * wrote before the document existed.
 */
const staleEmptyCorpusObjects = and(
  isNotNull(caseLawDecisions.textS3Key),
  isNotNull(caseLawDecisions.fulltext),
  ne(caseLawDecisions.fulltext, ""),
  inArray(caseLawDecisions.contentHash, [...EMPTY_CORPUS_CONTENT_HASHES]),
);

const rowsToBackfill: SQL | undefined = includeStaleEmpty
  ? or(missingCorpusObjects, staleEmptyCorpusObjects)
  : missingCorpusObjects;

const ingestionDb = createIngestionDb(rlsDb);

await refreshS3();
await refreshCorpusS3();

console.log(
  `=== BACKFILL CORPUS STORAGE ===${includeStaleEmpty ? " (including stale empty payloads)" : ""}`,
);

let lastId: SafeId<"caseLawDecision"> | null = null;
let written = 0;
let failed = 0;

const backfillRow = async (row: BackfillRow): Promise<void> => {
  try {
    const result = await writeCorpusDocument({
      documentId: row.id,
      jurisdiction: row.country,
      text: row.fulltext,
      sections: row.sections,
      ast: row.documentAst,
    });
    await ingestionDb((tx) =>
      tx
        .update(caseLawDecisions)
        .set({
          textS3Key: result.textKey,
          normalizedS3Key: result.sectionsKey,
          astS3Key: result.astKey,
          contentHash: result.contentHash,
        })
        // Compare-and-set on the selected row state: a concurrent
        // ingestion refresh may have written newer keys, and an
        // unconditional update would point the row back at the stale
        // backfill payload. The hash pins which payload this run read —
        // for a repaired row the keys are already set, so their absence
        // no longer proves the row is untouched.
        .where(
          and(
            eq(caseLawDecisions.id, row.id),
            sql`${caseLawDecisions.contentHash} IS NOT DISTINCT FROM ${row.contentHash}`,
            sql`${caseLawDecisions.updatedAt} IS NOT DISTINCT FROM ${row.updatedAt}`,
          ),
        ),
    );
    written += 1;
  } catch (error) {
    failed += 1;
    captureError(error, { decisionId: row.id, step: "backfillCorpusStorage" });
  }
};

while (true) {
  // Keyset by id so a row that fails to write (stays null) cannot stall
  // the scan; re-run the script later to retry the stragglers.
  const idFilter: SQL | undefined =
    lastId === null ? undefined : gt(caseLawDecisions.id, lastId);
  const where = idFilter ? and(rowsToBackfill, idFilter) : rowsToBackfill;

  // oxlint-disable-next-line no-await-in-loop -- sequential keyset pagination: next page cursor (lastId) depends on this query
  const rows: BackfillRow[] = await ingestionDb((tx) =>
    tx
      .select({
        id: caseLawDecisions.id,
        country: caseLawDecisions.country,
        fulltext: caseLawDecisions.fulltext,
        sections: caseLawDecisions.sections,
        documentAst: caseLawDecisions.documentAst,
        contentHash: caseLawDecisions.contentHash,
        updatedAt: caseLawDecisions.updatedAt,
      })
      .from(caseLawDecisions)
      .where(where)
      .orderBy(asc(caseLawDecisions.id))
      .limit(BATCH_SIZE),
  );

  if (rows.length === 0) {
    break;
  }

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    // oxlint-disable-next-line no-await-in-loop, no-db-await-in-loop/no-db-await-in-loop -- bounded concurrency: drain one CONCURRENCY-sized chunk before starting the next
    await Promise.all(rows.slice(i, i + CONCURRENCY).map(backfillRow));
  }

  lastId = rows.at(-1)?.id ?? lastId;
  console.log(`  written=${written} failed=${failed}`);
}

console.log(`Done. Wrote ${written} decisions, ${failed} failed.`);

// Non-zero on partial failure: the cutover checklist treats this run as
// green only when every decision has its corpus objects.
process.exit(failed === 0 ? 0 : 1);
