SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires CREATE INDEX CONCURRENTLY to run outside a transaction block.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint

-- The API persists only a hash; legacy email-ingest rows without a source key
-- remain valid during the migration-first rollout.
-- squawk-ignore prefer-robust-stmts
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "pending_uploads_email_source_uidx"
  ON "pending_uploads" (
    "organization_id",
    "workspace_id",
    (("purpose_data"->>'sourceKey'))
  )
  WHERE "purpose" = 'email_ingest'
    AND "purpose_data"->>'sourceKey' IS NOT NULL;--> statement-breakpoint
-- An interrupted concurrent build leaves an INVALID index that IF NOT EXISTS
-- would otherwise accept on retry. Reindexing is the online validity repair.
REINDEX INDEX CONCURRENTLY "pending_uploads_email_source_uidx";
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
