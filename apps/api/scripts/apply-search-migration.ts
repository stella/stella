/**
 * Apply search-specific migrations that Drizzle cannot
 * express declaratively. Creates the tsvector column +
 * GIN index for pg-fts.
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

import { sql } from "drizzle-orm";

import { db } from "@/api/db/root";

const applyPgFtsMigration = async () => {
  // Check if an existing generated column needs migration
  const colInfo = await db.execute(sql`
    SELECT is_generated
    FROM information_schema.columns
    WHERE table_name = 'search_documents'
      AND column_name = 'tsv'
  `);

  const isGenerated =
    colInfo.length > 0 && colInfo[0]?.is_generated === "ALWAYS";

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

  // Backfill: re-index existing rows with unaccent based on
  // the fts configs table. Always uses 'simple' regconfig to
  // match the search query path (plainto_tsquery('simple', ...)).
  console.log("Backfilling case_law tsv with unaccent config...");

  await db.execute(sql`
    UPDATE case_law_search_documents sd
    SET
      regconfig = 'simple',
      tsv = to_tsvector(
        'simple',
        CASE WHEN COALESCE(fc.use_unaccent, true)
          THEN unaccent(
            coalesce(sd.title, '') || ' ' ||
            coalesce(sd.searchable_text, ''))
          ELSE
            coalesce(sd.title, '') || ' ' ||
            coalesce(sd.searchable_text, '')
        END
      )
    FROM case_law_decisions d
    LEFT JOIN case_law_fts_configs fc
      ON fc.language = d.language
    WHERE d.id = sd.decision_id
      AND (sd.title IS NOT NULL OR sd.searchable_text IS NOT NULL)
  `);

  console.log("Case law search migration applied.");
};

const ensureUnaccentExtension = async () => {
  console.log("Ensuring unaccent extension...");
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS unaccent`);

  console.log("Ensuring unaccent text search config...");
  await db.execute(sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_ts_config
        WHERE cfgname = 'stella_unaccent'
          AND cfgnamespace = 'public'::regnamespace
      ) THEN
        CREATE TEXT SEARCH CONFIGURATION public.stella_unaccent (COPY = pg_catalog.simple);
      END IF;
    END
    $$;
  `);
  await db.execute(sql`
    ALTER TEXT SEARCH CONFIGURATION public.stella_unaccent
      ALTER MAPPING FOR
        asciiword,
        asciihword,
        hword_asciipart,
        word,
        hword,
        hword_part
      WITH unaccent, simple
  `);
};

const main = async () => {
  await ensureUnaccentExtension();
  await applyPgFtsMigration();
  await applyCaseLawSearchMigration();
  console.log("Search migration applied successfully.");
  process.exit(0);
};

main().catch((error: unknown) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
