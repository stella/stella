import { expect, test } from "bun:test";

import {
  CASE_LAW_CORPUS_INDEX_BACKFILL_STATUSES,
  CASE_LAW_CORPUS_INDEX_PROJECTION_ACTIONS,
} from "@/api/db/schema";

const caseLawCorpusIndexSource = new URL("corpus-index.ts", import.meta.url);
const publicSearchSource = new URL("decisions/search.ts", import.meta.url);
const sharedSearchProviderSource = new URL(
  "../../lib/legal-search/corpus-index-provider.ts",
  import.meta.url,
);
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
  expect(source).toMatch(
    /sql`LOCK TABLE \$\{caseLawDecisions\} IN SHARE MODE`/u,
  );
});

test("generation checkpoint migration preserves replay and role invariants", async () => {
  const source = await Bun.file(generationMigrationSource).text();

  expect(source).toContain(
    'ALTER TABLE "case_law_corpus_index_backfills" ENABLE ROW LEVEL SECURITY',
  );
  expect(source).toContain(
    'GRANT SELECT, INSERT, UPDATE, DELETE\n  ON TABLE "case_law_corpus_index_backfills" TO stella_ingestion',
  );
  expect(source.match(/SELECT 1 FROM pg_policies/gu)).toHaveLength(4);
  expect(source).toContain(
    'CONSTRAINT "case_law_corpus_index_projections_pk" PRIMARY KEY ("generation", "decision_id")',
  );
  expect(source).toContain(
    "AFTER INSERT OR UPDATE OF content_hash, indexed_hash, country",
  );
  expect(source).toContain("ON CONFLICT (generation, decision_id) DO UPDATE");
  expect(source).toContain("pending_hash = EXCLUDED.pending_hash");
  expect(source).toContain("pending_action = EXCLUDED.pending_action");
  expect(source).toContain("'delete', null, clock_timestamp()");
  expect(source).toContain(
    "NEW.indexed_generation =\n        (projection.generation || '_' || lower(NEW.country))",
  );
  for (const action of CASE_LAW_CORPUS_INDEX_PROJECTION_ACTIONS) {
    expect(source).toContain(`"pending_action" = '${action}'`);
  }
  expect(source).toContain(
    'DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_corpus_generation_cursor_idx"',
  );
  expect(source).toContain(
    'CREATE INDEX CONCURRENTLY "case_law_decisions_corpus_generation_cursor_idx"\n  ON "case_law_decisions" ("created_at", "id")',
  );
  expect(source).toContain(
    'CREATE INDEX CONCURRENTLY "case_law_decisions_corpus_hash_pending_idx"\n  ON "case_law_decisions" ("id")\n  WHERE "content_hash" IS NOT NULL AND "indexed_hash" IS NULL',
  );
  expect(source).toContain(
    'CREATE INDEX CONCURRENTLY "legislation_documents_corpus_hash_pending_idx"\n  ON "legislation_documents" ("id")\n  WHERE "content_hash" IS NOT NULL AND "indexed_hash" IS NULL',
  );
  expect(source).not.toContain(
    'DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_corpus_pending_idx"',
  );
  expect(source).not.toContain(
    'DROP INDEX CONCURRENTLY IF EXISTS "legislation_documents_corpus_pending_idx"',
  );
  expect(source).toContain(
    `CHECK ("status" IN (${CASE_LAW_CORPUS_INDEX_BACKFILL_STATUSES.map(
      (status) => `'${status}'`,
    ).join(",")}))`,
  );
  expect(source).toContain(
    'ALTER COLUMN "created_at" SET DEFAULT clock_timestamp()',
  );
});

test("every case-law corpus search boundary uses generation projection state", async () => {
  const consumers = await Promise.all(
    [publicSearchSource, sharedSearchProviderSource].map(
      async (source) => await Bun.file(source).text(),
    ),
  );
  for (const source of consumers) {
    expect(source).toContain("caseLawCorpusProjectionJoin(generation)");
    expect(source).toContain("currentCaseLawCorpusProjection(generation)");
  }
});
