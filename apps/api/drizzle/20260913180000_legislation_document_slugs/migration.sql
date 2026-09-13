SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The readable segment a public statute URL is addressed by. Additive and
-- nullable: every existing row starts NULL and stays reachable by id until
-- the backfill (src/scripts/backfill-statute-slugs.ts) fills it. New rows get
-- their slug at ingest from the legislation slug helper.
ALTER TABLE "legislation_documents" ADD COLUMN "slug" varchar(256);--> statement-breakpoint

-- Column grants are enumerated, so a new column is unreadable by the public
-- reader until it is named. The slug is the public address itself: it belongs
-- on that role's list and on no other.
GRANT SELECT ("slug")
  ON TABLE "legislation_documents"
  TO stella_public_law_reader;--> statement-breakpoint

-- NOT VALID keeps the ALTER off a full table scan; the paired validate
-- migration promotes it once the ledger has this one.
ALTER TABLE "legislation_documents"
  ADD CONSTRAINT "legislation_documents_slug_shape"
  CHECK ("slug" IS NULL OR "slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$') NOT VALID;--> statement-breakpoint

-- Built CONCURRENTLY so the lookup path never write-locks the corpus table.
-- Drizzle wraps pending migrations in one transaction and CREATE INDEX
-- CONCURRENTLY must run outside one: COMMIT, build, then BEGIN again for the
-- migrator's bookkeeping row (same split as 20260603120000_case_law_public_slugs).
SELECT set_config(
  'stella.migration_statement_timeout',
  current_setting('statement_timeout'),
  false
);
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
COMMIT;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "legislation_documents_country_slug_idx"
  ON "legislation_documents" ("country", "slug")
  WHERE "slug" IS NOT NULL;
--> statement-breakpoint
SELECT set_config(
  'statement_timeout',
  current_setting('stella.migration_statement_timeout'),
  false
);
--> statement-breakpoint
BEGIN;
