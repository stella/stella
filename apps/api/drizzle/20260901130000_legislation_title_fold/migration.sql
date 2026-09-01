SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The statute list matches titles the way a lawyer types them: without
-- diacritics and in any case. `unaccent()` is only STABLE, so it cannot back an
-- index directly; this wrapper pins the dictionary and declares the result
-- immutable, which it is for a fixed dictionary. Keep it byte-equal to
-- `lower(unaccent(...))`: the query side folds through the same function, and
-- the pglite test double is generated from the same fold table
-- (@stll/text-normalize ASCII_FOLD_TABLE) that the unaccent parity test pins.
CREATE OR REPLACE FUNCTION legislation_title_fold(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT lower(public.unaccent('public.unaccent'::regdictionary, $1))
$$;
--> statement-breakpoint

-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires CREATE INDEX CONCURRENTLY to run outside a transaction block.
-- Split the migrator transaction, lift the timeouts for the concurrent builds
-- (which take no lock those timeouts guard), then restore and reopen a
-- transaction for Drizzle's migration row. Same shape as
-- 20260729010000_corpus_index_pending_partial_indexes.
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint

-- Drops only this migration's own index by name before recreating it. A
-- cancelled concurrent build leaves an INVALID index behind, and IF NOT
-- EXISTS would then skip recreating it.
DROP INDEX CONCURRENTLY IF EXISTS "legislation_documents_title_fold_trgm_idx";
--> statement-breakpoint
-- Diacritics-insensitive contains/prefix matching on the title.
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "legislation_documents_title_fold_trgm_idx"
  ON "legislation_documents" USING gin (legislation_title_fold("title") gin_trgm_ops);
--> statement-breakpoint

-- Same reasoning as the index above, for the recency walk.
DROP INDEX CONCURRENTLY IF EXISTS "legislation_documents_country_valid_from_id_idx";
--> statement-breakpoint
-- The default listing walks a country's works newest consolidation first and
-- stops at the page limit; the expression is the handler's own sort key, so
-- the walk is an index range read backwards rather than a sort of the corpus.
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "legislation_documents_country_valid_from_id_idx"
  ON "legislation_documents" ("country", coalesce("version_valid_from", DATE '0001-01-01'), "id");
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
