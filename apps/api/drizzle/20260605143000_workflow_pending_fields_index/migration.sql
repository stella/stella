-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires CREATE INDEX CONCURRENTLY to run outside a transaction block.
-- Split the migrator transaction, build the large-table index without
-- write-blocking locks, then reopen a transaction for Drizzle's migration row.
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
-- The runner validates this index and concurrently repairs an INVALID build.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "fields_pending_workspace_idx" ON "fields" ("workspace_id") WHERE "content"->>'type' = 'pending';
--> statement-breakpoint
SELECT set_config(
  'statement_timeout',
  current_setting('stella.migration_statement_timeout'),
  false
);
--> statement-breakpoint
BEGIN;
