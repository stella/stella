import { expect, test } from "bun:test";

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
});
