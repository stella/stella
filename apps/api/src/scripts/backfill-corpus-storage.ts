import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

/**
 * Backfill: copy existing canonical text/sections/AST from the Postgres
 * columns into object storage and record the keys + content hash. Run
 * once before flipping reads to corpus storage; safe to re-run (it only
 * processes rows whose `text_s3_key` is still null).
 *
 *   CORPUS_STORAGE_ENABLED=true LEGAL_CORPUS_S3_BUCKET=... \
 *     bun run src/scripts/backfill-corpus-storage.ts
 */
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { createIngestionDb } from "@/api/db";
import { rlsDb } from "@/api/db/root";
import { caseLawDecisions } from "@/api/db/schema";
import { writeCorpusDocument } from "@/api/handlers/case-law/corpus-storage";
import type { EmptyAst } from "@/api/handlers/case-law/ingestion/adapter";
import type { DecisionSection } from "@/api/handlers/case-law/types";
import { captureError } from "@/api/lib/analytics";
import type { SafeId } from "@/api/lib/branded-types";
import { refreshCorpusS3, refreshS3 } from "@/api/lib/s3";

const BATCH_SIZE = 50;
const CONCURRENCY = 4;

type BackfillRow = {
  id: SafeId<"caseLawDecision">;
  country: string;
  fulltext: string | null;
  sections: DecisionSection[] | null;
  documentAst: DocumentAst | EmptyAst | null;
  updatedAt: Date;
};

const ingestionDb = createIngestionDb(rlsDb);

await refreshS3();
await refreshCorpusS3();

console.log("=== BACKFILL CORPUS STORAGE ===");

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
        // backfill payload.
        .where(
          and(
            eq(caseLawDecisions.id, row.id),
            isNull(caseLawDecisions.textS3Key),
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
  const where = idFilter
    ? and(isNull(caseLawDecisions.textS3Key), idFilter)
    : isNull(caseLawDecisions.textS3Key);

  const rows: BackfillRow[] = await ingestionDb((tx) =>
    tx
      .select({
        id: caseLawDecisions.id,
        country: caseLawDecisions.country,
        fulltext: caseLawDecisions.fulltext,
        sections: caseLawDecisions.sections,
        documentAst: caseLawDecisions.documentAst,
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
    await Promise.all(rows.slice(i, i + CONCURRENCY).map(backfillRow));
  }

  lastId = rows.at(-1)?.id ?? lastId;
  console.log(`  written=${written} failed=${failed}`);
}

console.log(`Done. Wrote ${written} decisions, ${failed} failed.`);

process.exit(0);
