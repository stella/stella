SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - retry cleanup only drops the Arabic normalization indexes introduced by this same migration, immediately before rebuilding them concurrently; rollback is to drop these additive indexes and function.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
-- Search match-key fold for Arabic. Must stay byte-for-byte equal to
-- @stll/text-normalize's normalizeSearchText (golden vectors pin both).
-- NFKC folds presentation forms; the regexp strips tatweel (U+0640), the
-- eight harakat (U+064B-0652) and superscript alef (U+0670); translate
-- folds alef/hamza/teh-marbuta/yeh variants and Arabic-Indic digits,
-- pins ASCII case folding independently of database collation, and deletes
-- the standalone hamza (no counterpart in the target).
CREATE OR REPLACE FUNCTION arabic_normalize(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT btrim(
    regexp_replace(
      translate(
        regexp_replace(
          normalize($1, NFKC),
          '[ـً-ْٰ]',
          '',
          'g'
        ),
        'آأإٱؤئةى٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹ABCDEFGHIJKLMNOPQRSTUVWXYZİء',
        'ااااويهي01234567890123456789abcdefghijklmnopqrstuvwxyzi'
      ),
      U&'[ \0009\000A\000B\000C\000D\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+',
      ' ',
      'g'
    )
  )
$$;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
-- Build the trigram indexes concurrently: contacts can be large enough that
-- a regular index build would write-lock a user-facing table. Drizzle wraps
-- pending migrations in one transaction, while PostgreSQL requires CREATE
-- INDEX CONCURRENTLY to run outside a transaction block.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "contacts_display_name_arabic_norm_trgm_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "contacts_display_name_arabic_norm_trgm_idx"
  ON "contacts" USING gin (arabic_normalize("display_name") gin_trgm_ops);
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "contacts_first_name_arabic_norm_trgm_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "contacts_first_name_arabic_norm_trgm_idx"
  ON "contacts" USING gin (arabic_normalize("first_name") gin_trgm_ops);
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "contacts_last_name_arabic_norm_trgm_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "contacts_last_name_arabic_norm_trgm_idx"
  ON "contacts" USING gin (arabic_normalize("last_name") gin_trgm_ops);
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "contacts_organization_name_arabic_norm_trgm_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "contacts_organization_name_arabic_norm_trgm_idx"
  ON "contacts" USING gin (arabic_normalize("organization_name") gin_trgm_ops);
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
--> statement-breakpoint
SET statement_timeout = '5s';
