SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

-- The cross-matter day view walks one user's entries by organization, date,
-- and ID. Build this index without blocking time-entry writes.
-- Drizzle wraps migrations in a transaction; PostgreSQL requires concurrent
-- index operations outside that transaction.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

-- stella-migration-safety: reviewed destructive-change - retry cleanup removes
-- only this migration's index if a cancelled concurrent build left it invalid.
DROP INDEX CONCURRENTLY IF EXISTS "time_entries_org_user_date_id_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "time_entries_org_user_date_id_idx"
  ON "time_entries" ("organization_id", "user_id", "date_worked", "id");
--> statement-breakpoint

SET statement_timeout = '10s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
