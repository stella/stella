import { panic } from "better-result";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { globalCaseLawHitsStatement } from "@/api/lib/search/index-global";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

import { capturedStatementQuery } from "./statement-measurement";

const CASE_LAW_SEARCH_MATCHES = 200;
export const CASE_LAW_SEARCH_FETCH_LIMIT = 11;
export const CASE_LAW_SEARCH_SIZES = [3000, 30_000] as const;
const SOURCE_ID = "01990000-00b0-7000-8000-000000000001";

export const caseLawSearchStatement = () =>
  globalCaseLawHitsStatement({
    query: "smlouva",
    searchCursor: null,
    fetchLimit: CASE_LAW_SEARCH_FETCH_LIMIT,
  });

/** Move the page bound after enrichment to reproduce the former scan. */
export const unboundedCaseLawSearchStatement = () => {
  const compiled = new PgDialect().sqlToQuery(caseLawSearchStatement());
  const boundary = /\n\s+ORDER BY [^\n]+\n\s+LIMIT (\$\d+)\n\s+\)/u;
  const limit =
    boundary.exec(compiled.sql)?.at(1) ??
    panic("Case-law page boundary missing from mutation fixture");
  const candidates = compiled.sql
    .replace("WITH page AS MATERIALIZED", "WITH page AS NOT MATERIALIZED")
    .replace(boundary, "\n    )");
  const text = `${candidates} LIMIT ${limit}`;
  return capturedStatementQuery({ text, params: compiled.params });
};

/** Grow one isolated corpus; fixed matches and page size at both populations. */
export const seedCaseLawSearch = async (
  database: GatedTestDb,
  rows: number,
) => {
  await database.execute(sql`INSERT INTO case_law_sources (id, adapter_key, name)
    VALUES (${SOURCE_ID}, 'global-search-perf', 'Case law search fixture') ON CONFLICT DO NOTHING`);
  // Seed published read data directly, as the corpus fixture does: projection
  // and extraction enqueue triggers would benchmark ingestion instead. Foreign
  // keys and CHECK constraints still hold; DDL rolls back with this transaction.
  await database.transaction(async (tx) => {
    await tx.execute(sql`ALTER TABLE case_law_decisions DISABLE TRIGGER USER`);
    await tx.execute(
      sql`ALTER TABLE case_law_search_documents DISABLE TRIGGER USER`,
    );
    // Wide, incompressible sections exercise TOAST reads before/after LIMIT.
    // Only matches need large bodies; unrelated rows still grow the indexes.
    await tx.execute(sql`INSERT INTO case_law_decisions
    (id, source_id, case_number, docket_family_key, court, country, language, sections, updated_at)
    SELECT ('01990000-00b1-7000-8000-' || lpad(n::text, 12, '0'))::uuid,
      ${SOURCE_ID}, n || ' As 1/2025', n || 'as1/2025', 'Nejvyšší správní soud', 'CZE', 'cs',
      CASE WHEN n <= ${CASE_LAW_SEARCH_MATCHES} THEN (
        SELECT jsonb_agg(jsonb_build_object('index', section, 'type', 'paragraph',
          'text', 'smlouva ' || (SELECT string_agg(md5(n || ':' || section || ':' || word), ' ') FROM generate_series(1, 16) words(word))))
        FROM generate_series(1, 512) sections(section)
      ) ELSE '[]'::jsonb END,
      '2026-01-01T00:00:00Z'::timestamptz
    FROM generate_series(1, ${rows}::integer) series(n)
    ON CONFLICT DO NOTHING`);
    await tx.execute(sql`INSERT INTO case_law_search_documents
    (decision_id, title, searchable_text, language, tsv)
    SELECT id, case_number, CASE WHEN right(id::text, 12)::bigint <= ${CASE_LAW_SEARCH_MATCHES} THEN 'smlouva' ELSE 'ordinary' END,
      'cs', to_tsvector('public.stella_unaccent', CASE WHEN right(id::text, 12)::bigint <= ${CASE_LAW_SEARCH_MATCHES} THEN 'smlouva' ELSE 'ordinary' END)
    FROM case_law_decisions WHERE source_id = ${SOURCE_ID}
    ON CONFLICT DO NOTHING`);
    await tx.execute(
      sql`ALTER TABLE case_law_search_documents ENABLE TRIGGER USER`,
    );
    await tx.execute(sql`ALTER TABLE case_law_decisions ENABLE TRIGGER USER`);
  });
  for (const table of [
    "case_law_sources",
    "case_law_decisions",
    "case_law_search_documents",
    "case_law_decision_identifiers",
  ] as const) {
    // db-await-in-loop: four fixed tables; VACUUM cannot share a transaction.
    await database.execute(sql.raw(`VACUUM (ANALYZE) ${table}`));
  }
};
