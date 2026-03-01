/**
 * Apply search-specific migrations that Drizzle cannot
 * express declaratively.
 *
 * Creates:
 * 1. tsvector generated column + GIN index (pg-fts)
 * 2. BM25 index (paradedb, if pg_search extension exists)
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
  console.log("Adding tsvector column to search_documents...");

  await db.execute(sql`
    ALTER TABLE search_documents
      ADD COLUMN IF NOT EXISTS tsv tsvector
      GENERATED ALWAYS AS (
        to_tsvector('english',
          coalesce(title, '') || ' ' ||
          coalesce(searchable_text, ''))
      ) STORED
  `);

  console.log("Creating GIN index on tsv column...");

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS search_documents_tsv_idx
      ON search_documents USING gin (tsv)
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

const main = async () => {
  await applyPgFtsMigration();
  await applyParadedbMigration();
  console.log("Search migration applied successfully.");
  process.exit(0);
};

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
