import { and, asc, eq, gt, isNotNull, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

/**
 * Column trim: drop the Postgres `fulltext` / `sections` / `document_ast`
 * columns for decisions whose canonical payload already lives in object
 * storage, and remove their pg-fts projection (a canonical row is served
 * by the corpus index, so the tsvector row is dead weight).
 *
 * A row is only trimmed once object storage is proven to hold exactly
 * what is about to be deleted: every object is read back, decompressed
 * and compared against the column it stands in for. That costs the scan
 * both payloads — the columns from Postgres and the objects from the
 * bucket — which is the right trade for a one-off pass whose mistakes
 * are unrecoverable. Batches stay small and keyset-paginated for it.
 * Rows whose columns hold no document skip the comparison: presence is
 * all they need, because there is nothing to lose. The update is
 * compare-and-set against the row state it read, so the run is
 * idempotent and safe to repeat.
 *
 *   CORPUS_STORAGE_MODE=canonical LEGAL_CORPUS_S3_BUCKET=... \
 *     bun run src/scripts/corpus-column-trim.ts [--limit N] [--dry-run] [--force]
 */
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { rlsDb } from "@/api/db/root";
import { caseLawDecisions, caseLawSearchDocuments } from "@/api/db/schema";
import { createIngestionDb } from "@/api/db/scoped";
import { corpusStorageMode } from "@/api/env-base";
import {
  readCorpusAst,
  readCorpusSections,
  readCorpusText,
} from "@/api/handlers/case-law/corpus-storage";
import type { EmptyAst } from "@/api/handlers/case-law/ingestion/adapter";
import { payloadCarriesDocument } from "@/api/handlers/case-law/stored-payload";
import type { DecisionSection } from "@/api/handlers/case-law/types";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { getCorpusS3, refreshCorpusS3, refreshS3 } from "@/api/lib/s3";
import { withTimeout } from "@/api/lib/with-timeout";
import type { CorpusObjectState } from "@/api/scripts/corpus-column-trim-plan";
import {
  columnTrimGate,
  corpusObjectState,
  parseColumnTrimArgs,
  planColumnTrim,
} from "@/api/scripts/corpus-column-trim-plan";

const BATCH_SIZE = 50;
const CONCURRENCY = 4;

type TrimRow = {
  id: SafeId<"caseLawDecision">;
  textS3Key: string | null;
  normalizedS3Key: string | null;
  astS3Key: string | null;
  contentHash: string | null;
  /** The payload this run would delete, which it has to hash first. */
  fulltext: string | null;
  sections: DecisionSection[] | null;
  documentAst: DocumentAst | EmptyAst | null;
  updatedAt: Date;
};

const parsed = parseColumnTrimArgs(Bun.argv.slice(2));
if (parsed.type === "invalid") {
  console.error(parsed.message);
  process.exit(2);
}
const { limit, dryRun, force } = parsed.args;

const gate = columnTrimGate({ mode: corpusStorageMode, force });
if (gate.type === "refused") {
  console.error(gate.reason);
  process.exit(2);
}

const ingestionDb = createIngestionDb(rlsDb);

await refreshS3();
await refreshCorpusS3();

const runLabel = [
  dryRun ? "dry run" : "live",
  limit === null ? "no limit" : `limit=${limit}`,
].join(", ");

console.log(`=== CORPUS COLUMN TRIM (${runLabel}) ===`);

let lastId: SafeId<"caseLawDecision"> | null = null;
let trimmed = 0;
let skipped = 0;
let failed = 0;
let scanned = 0;

// Rows whose payload is in object storage but whose Postgres columns are
// still populated. `contentHash` must be present too: it is the CAS token
// the update below compares against.
const candidateFilter = and(
  isNotNull(caseLawDecisions.textS3Key),
  isNotNull(caseLawDecisions.contentHash),
  or(
    isNotNull(caseLawDecisions.fulltext),
    isNotNull(caseLawDecisions.sections),
    isNotNull(caseLawDecisions.documentAst),
  ),
);

const corpusObjectExists = async (key: string): Promise<boolean> =>
  await withTimeout(async () => await getCorpusS3().file(key).exists(), {
    label: "corpus-column-trim-exists",
    timeoutMs: LIMITS.corpusObjectIoTimeoutMs,
  });

type ObjectCheck = {
  key: string | null;
  /**
   * Reads the object and answers whether it holds what the column
   * holds. Not called where the column holds no document.
   */
  matchesColumn: () => Promise<boolean>;
};

const checkObject = async (
  { key, matchesColumn }: ObjectCheck,
  compareContent: boolean,
): Promise<CorpusObjectState> => {
  if (key === null) {
    return corpusObjectState({
      key,
      exists: false,
      matchesColumn: "not-checked",
    });
  }
  const exists = await corpusObjectExists(key);
  if (!exists || !compareContent) {
    return corpusObjectState({ key, exists, matchesColumn: "not-checked" });
  }
  return corpusObjectState({
    key,
    exists,
    matchesColumn: await matchesColumn(),
  });
};

const trimRow = async (row: TrimRow): Promise<void> => {
  try {
    const columnPayload = {
      text: row.fulltext,
      sections: row.sections,
      ast: row.documentAst,
    };
    // Every object whose column this run nulls has to be checked,
    // sections included: `writeCorpusDocument` always writes a sections
    // object, so its absence means the row is not actually backed by
    // object storage. Where the columns hold a document, presence is not
    // enough and the object's content is compared with the column's;
    // `Bun.deepEquals` rather than a serialization, because the columns
    // come back through jsonb with their keys reordered.
    const compareContent = payloadCarriesDocument(columnPayload);
    const [text, sections, ast] = await Promise.all([
      checkObject(
        {
          key: row.textS3Key,
          matchesColumn: async () =>
            row.textS3Key !== null &&
            (await readCorpusText(row.textS3Key)) === (row.fulltext ?? ""),
        },
        compareContent,
      ),
      checkObject(
        {
          key: row.normalizedS3Key,
          matchesColumn: async () =>
            row.normalizedS3Key !== null &&
            Bun.deepEquals(
              await readCorpusSections(row.normalizedS3Key),
              row.sections ?? null,
            ),
        },
        compareContent,
      ),
      checkObject(
        {
          key: row.astS3Key,
          matchesColumn: async () =>
            row.astS3Key !== null &&
            Bun.deepEquals(
              await readCorpusAst(row.astS3Key),
              row.documentAst ?? null,
            ),
        },
        compareContent,
      ),
    ]);

    const decision = planColumnTrim({
      text,
      sections,
      ast,
      columnPayload,
      contentHash: row.contentHash,
    });

    if (decision.type === "skip") {
      skipped += 1;
      console.log(`  skip ${row.id}: ${decision.reason}`);
      return;
    }

    if (dryRun) {
      trimmed += 1;
      return;
    }

    const applied = await ingestionDb(async (tx) => {
      const updated = await tx
        .update(caseLawDecisions)
        .set({ fulltext: null, sections: null, documentAst: null })
        // Compare-and-set on the row state this scan read: a concurrent
        // ingestion refresh may have replaced the payload, in which case
        // the columns it just wrote are canonical and must survive.
        .where(
          and(
            eq(caseLawDecisions.id, row.id),
            sql`${caseLawDecisions.contentHash} IS NOT DISTINCT FROM ${row.contentHash}`,
            sql`${caseLawDecisions.updatedAt} IS NOT DISTINCT FROM ${row.updatedAt}`,
          ),
        )
        .returning({ id: caseLawDecisions.id });

      if (updated.length === 0) {
        return false;
      }

      // The tsvector projection only serves pg-fts, which cannot rank a
      // row whose text columns are gone.
      await tx
        .delete(caseLawSearchDocuments)
        .where(eq(caseLawSearchDocuments.decisionId, row.id));

      return true;
    });

    if (applied) {
      trimmed += 1;
      return;
    }

    skipped += 1;
    console.log(`  skip ${row.id}: row changed under the scan`);
  } catch (error) {
    failed += 1;
    captureError(error, { decisionId: row.id, step: "corpusColumnTrim" });
  }
};

while (true) {
  const remaining = limit === null ? BATCH_SIZE : limit - scanned;
  if (remaining <= 0) {
    break;
  }

  const idFilter: SQL | undefined =
    lastId === null ? undefined : gt(caseLawDecisions.id, lastId);

  // oxlint-disable-next-line no-await-in-loop -- sequential keyset pagination: the next page cursor (lastId) depends on this query
  const rows: TrimRow[] = await ingestionDb((tx) =>
    tx
      .select({
        id: caseLawDecisions.id,
        textS3Key: caseLawDecisions.textS3Key,
        normalizedS3Key: caseLawDecisions.normalizedS3Key,
        astS3Key: caseLawDecisions.astS3Key,
        contentHash: caseLawDecisions.contentHash,
        fulltext: caseLawDecisions.fulltext,
        sections: caseLawDecisions.sections,
        documentAst: caseLawDecisions.documentAst,
        updatedAt: caseLawDecisions.updatedAt,
      })
      .from(caseLawDecisions)
      .where(idFilter ? and(candidateFilter, idFilter) : candidateFilter)
      .orderBy(asc(caseLawDecisions.id))
      .limit(Math.min(BATCH_SIZE, remaining)),
  );

  if (rows.length === 0) {
    break;
  }

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    // oxlint-disable-next-line no-await-in-loop, no-db-await-in-loop/no-db-await-in-loop -- bounded concurrency: drain one CONCURRENCY-sized chunk before starting the next
    await Promise.all(rows.slice(i, i + CONCURRENCY).map(trimRow));
  }

  scanned += rows.length;
  lastId = rows.at(-1)?.id ?? lastId;
  console.log(`  trimmed=${trimmed} skipped=${skipped} failed=${failed}`);
}

console.log(
  `Done. Trimmed ${trimmed} decisions, skipped ${skipped}, ${failed} failed.`,
);

// Non-zero on partial failure so a caller can tell an incomplete pass from
// a clean one; re-running picks up whatever was left behind.
process.exit(failed === 0 ? 0 : 1);
