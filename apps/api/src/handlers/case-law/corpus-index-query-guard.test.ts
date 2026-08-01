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
const GENERATION_STATE_TABLES = [
  "case_law_corpus_index_backfills",
  "case_law_corpus_index_source_reconciliations",
  "case_law_corpus_index_writer_leases",
  "case_law_corpus_index_projections",
] as const;

test("case-law incremental corpus scans never select a generation inequality", async () => {
  const source = await Bun.file(caseLawCorpusIndexSource).text();
  // A generation cutover must be a durable keyset walk. `<>` turns its
  // selector into a corpus-wide scan and can starve request traffic.
  expect(source).not.toMatch(/indexedGeneration\}[^`]*<>/su);
  expect(source).not.toMatch(/indexed_generation[^`]*<>/su);
  expect(source).toMatch(
    /sql`LOCK TABLE \$\{caseLawDecisions\}, \$\{caseLawSources\} IN SHARE MODE`/u,
  );
});

test("generation checkpoint migration preserves replay and role invariants", async () => {
  const source = await Bun.file(generationMigrationSource).text();

  for (const table of GENERATION_STATE_TABLES) {
    expect(source).toContain(
      `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`,
    );
    expect(source).toContain(
      `GRANT SELECT, INSERT, UPDATE, DELETE\n  ON TABLE "${table}" TO stella_ingestion`,
    );
    expect(
      source.match(new RegExp(`tablename = '${table}'`, "gu")),
    ).toHaveLength(2);
  }
  expect(source).toContain(
    'CONSTRAINT "case_law_corpus_index_projections_pk" PRIMARY KEY ("generation", "decision_id")',
  );
  expect(source).toContain(
    "AFTER INSERT OR UPDATE OF content_hash, indexed_hash, country",
  );
  expect(source).toContain("AFTER UPDATE OF descriptor");
  expect(source).toContain(
    "SET revision = case_law_corpus_index_source_reconciliations.revision + 1",
  );
  expect(source).toContain("cursor_created_at = null");
  expect(source).toContain("cursor_id = null");
  expect(
    source.match(
      /ON CONFLICT ON CONSTRAINT case_law_corpus_index_projections_pk DO UPDATE/gu,
    ),
  ).toHaveLength(2);
  expect(source).not.toContain("ON CONFLICT (");
  expect(source).toContain("pending_hash = EXCLUDED.pending_hash");
  expect(source).toContain(
    "\"pending_index_ids\" varchar(64)[] DEFAULT '{}'::varchar(64)[] NOT NULL",
  );
  expect(source).toContain("pending_index_ids = ARRAY(");
  expect(source).toContain(
    "case_law_corpus_index_projections.pending_index_ids",
  );
  expect(source).toContain("pending_action = EXCLUDED.pending_action");
  expect(source).toContain("'delete', null, '{}', clock_timestamp()");
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
    'CREATE INDEX IF NOT EXISTS "case_law_corpus_index_projections_decision_idx"\n  ON "case_law_corpus_index_projections" ("decision_id")',
  );
  expect(source).toContain(
    'CREATE INDEX CONCURRENTLY "case_law_decisions_source_generation_cursor_idx"\n  ON "case_law_decisions" ("source_id", "created_at", "id")',
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
