SELECT set_config(
  'stella.migration_lock_timeout',
  current_setting('lock_timeout'),
  false
);--> statement-breakpoint
SELECT set_config(
  'stella.migration_statement_timeout',
  current_setting('statement_timeout'),
  false
);--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Filter-only case-law search has no full-text predicate: it reads newest
-- decisions by their authoritative (updated_at, id). Build the matching index
-- without blocking reads or ingestion on the existing public corpus table.
--
-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires CREATE INDEX CONCURRENTLY to run outside a transaction block.
-- Split the migrator transaction, lift the timeouts for the concurrent build,
-- then restore and reopen a transaction for Drizzle's migration row. The
-- online migration reconciler validates the replacement and performs the
-- replay-safe cutover after the ledger entry commits.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

CREATE INDEX CONCURRENTLY IF NOT EXISTS "case_law_decisions_updated_id_idx_replacement"
  ON "case_law_decisions" ("updated_at" DESC, "id" DESC);
--> statement-breakpoint
SELECT set_config(
  'statement_timeout',
  current_setting('stella.migration_statement_timeout'),
  false
);
--> statement-breakpoint
SELECT set_config(
  'lock_timeout',
  current_setting('stella.migration_lock_timeout'),
  false
);
--> statement-breakpoint

-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
