/**
 * Apply search-specific migrations that Drizzle cannot
 * express declaratively.
 *
 * Creates:
 * 1. tsvector column + GIN index (pg-fts)
 * 2. BM25 index (paradedb, if pg_search extension exists)
 *
 * The tsv column is a regular (non-generated) column so
 * each document can use its own regconfig for stemming.
 * It is populated at index time by pg-fts-provider.
 *
 * Usage:
 *   bun apps/api/scripts/apply-search-migration.ts
 *
 * Idempotent: safe to run multiple times (IF NOT EXISTS).
 */

import "dotenv/config";

import { sql } from "drizzle-orm";

import { db } from "@/api/db";

const applyPgFtsMigration = async () => {
  // Check if an existing generated column needs migration
  const colInfo = await db.execute(sql`
    SELECT is_generated
    FROM information_schema.columns
    WHERE table_name = 'search_documents'
      AND column_name = 'tsv'
  `);

  const isGenerated =
    colInfo.rows.length > 0 && colInfo.rows[0].is_generated === "ALWAYS";

  if (isGenerated) {
    console.log("Migrating tsv from generated to regular column...");
    await db.execute(sql`
      ALTER TABLE search_documents DROP COLUMN tsv
    `);
  }

  console.log("Adding tsvector column to search_documents...");

  await db.execute(sql`
    ALTER TABLE search_documents
      ADD COLUMN IF NOT EXISTS tsv tsvector
  `);

  console.log("Creating GIN index on tsv column...");

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS search_documents_tsv_idx
      ON search_documents USING gin (tsv)
  `);

  // Backfill: populate tsv for rows that have text but
  // no tsv yet (e.g. after migration from generated col).
  console.log("Backfilling tsv for existing rows...");

  await db.execute(sql`
    UPDATE search_documents
    SET tsv = to_tsvector(
      coalesce(language, 'simple')::regconfig,
      coalesce(title, '') || ' ' ||
      coalesce(searchable_text, '')
    )
    WHERE tsv IS NULL
      AND (title IS NOT NULL OR searchable_text IS NOT NULL)
  `);

  console.log("pg-fts migration applied.");
};

const applyParadedbMigration = async () => {
  // Check if pg_search extension is installed
  const extResult = await db.execute(sql`
    SELECT 1 FROM pg_extension
    WHERE extname = 'pg_search'
  `);

  if (extResult.rows.length === 0) {
    console.log("pg_search extension not found, skipping BM25 index.");
    return;
  }

  console.log("Creating BM25 index on search_documents...");

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS search_documents_bm25_idx
      ON search_documents
      USING bm25 (
        entity_id,
        title,
        searchable_text,
        organization_id,
        workspace_id,
        kind
      )
      WITH (key_field = 'entity_id')
  `);

  console.log("ParadeDB BM25 index created.");
};

const applyCaseLawSearchMigration = async () => {
  console.log("Adding tsvector column to case_law_search_documents...");

  await db.execute(sql`
    ALTER TABLE case_law_search_documents
      ADD COLUMN IF NOT EXISTS tsv tsvector
  `);

  console.log("Creating GIN index on case_law tsv column...");

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS case_law_search_docs_tsv_idx
      ON case_law_search_documents USING gin (tsv)
  `);

  console.log("Case law search migration applied.");
};

const main = async () => {
  await applyPgFtsMigration();
  await applyParadedbMigration();
  await applyCaseLawSearchMigration();
  console.log("Search migration applied successfully.");
  process.exit(0);
};

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
