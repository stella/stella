SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A stable identity for a failure row whose record a caller can name, so a
-- replayed record lands on its existing row instead of adding another.
-- Additive and nullable: rows written without an identity keep their shape.
ALTER TABLE "case_law_ingestion_failures"
  ADD COLUMN IF NOT EXISTS "record_identity" varchar(256);--> statement-breakpoint

-- Built CONCURRENTLY so failure writes continue during the build. Drizzle
-- wraps pending migrations in one transaction and CREATE INDEX CONCURRENTLY
-- must run outside one: COMMIT, build, then BEGIN again for the migrator's
-- bookkeeping row. The REINDEX repairs an INVALID index an interrupted build
-- left behind, so a retry never keeps an index that enforces nothing.
SELECT set_config(
  'stella.migration_statement_timeout',
  current_setting('statement_timeout'),
  false
);--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "case_law_ingestion_failures_source_record_uidx"
  ON "case_law_ingestion_failures" ("source_id", "record_identity")
  WHERE "record_identity" IS NOT NULL;--> statement-breakpoint
REINDEX INDEX CONCURRENTLY "case_law_ingestion_failures_source_record_uidx";--> statement-breakpoint
SELECT set_config(
  'statement_timeout',
  current_setting('stella.migration_statement_timeout'),
  false
);--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
