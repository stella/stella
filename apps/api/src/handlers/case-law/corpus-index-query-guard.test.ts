import { expect, test } from "bun:test";

import { CASE_LAW_CORPUS_INDEX_BACKFILL_STATUSES } from "@/api/db/schema";

const caseLawCorpusIndexSource = new URL("corpus-index.ts", import.meta.url);
const generationMigrationSource = new URL(
  "../../../drizzle/20260731170000_case_law_corpus_generation_backfill/migration.sql",
  import.meta.url,
);

test("case-law incremental corpus scans never select a generation inequality", async () => {
  const source = await Bun.file(caseLawCorpusIndexSource).text();
  // A generation cutover must be a durable keyset walk. `<>` turns its
  // selector into a corpus-wide scan and can starve request traffic.
  expect(source).not.toMatch(/indexedGeneration\}[^`]*<>/su);
  expect(source).not.toMatch(/indexed_generation[^`]*<>/su);
});

test("generation checkpoint migration preserves replay and role invariants", async () => {
  const source = await Bun.file(generationMigrationSource).text();

  expect(source).toContain(
    'ALTER TABLE "case_law_corpus_index_backfills" ENABLE ROW LEVEL SECURITY',
  );
  expect(source).toContain(
    'GRANT SELECT, INSERT, UPDATE, DELETE\n  ON TABLE "case_law_corpus_index_backfills" TO stella_ingestion',
  );
  expect(source.match(/SELECT 1 FROM pg_policies/gu)).toHaveLength(2);
  expect(source).toContain(
    'DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_corpus_generation_cursor_idx"',
  );
  expect(source).toContain(
    'CREATE INDEX CONCURRENTLY "case_law_decisions_corpus_generation_cursor_idx"\n  ON "case_law_decisions" ("created_at", "id")',
  );
  expect(source).toContain(
    'CREATE INDEX CONCURRENTLY "case_law_decisions_corpus_pending_idx"\n  ON "case_law_decisions" ("id")\n  WHERE "content_hash" IS NOT NULL AND "indexed_hash" IS NULL',
  );
  expect(source).toContain(
    'CREATE INDEX CONCURRENTLY "legislation_documents_corpus_pending_idx"\n  ON "legislation_documents" ("id")\n  WHERE "content_hash" IS NOT NULL AND "indexed_hash" IS NULL',
  );
  expect(source).not.toContain(
    '"content_hash" IS NOT NULL AND "indexed_generation" IS NULL',
  );
  expect(source).toContain(
    `CHECK ("status" IN (${CASE_LAW_CORPUS_INDEX_BACKFILL_STATUSES.map(
      (status) => `'${status}'`,
    ).join(",")}))`,
  );
});
