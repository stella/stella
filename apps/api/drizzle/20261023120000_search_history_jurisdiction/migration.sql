-- requires: 20261010003000_search_history_import_cutoffs
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Nullable: entries recorded before history was kept per country have none.
ALTER TABLE "search_history_entries" ADD COLUMN "jurisdiction" varchar(8);
--> statement-breakpoint

-- The law page lists one owner's history in one country, newest first.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

DROP INDEX CONCURRENTLY IF EXISTS "search_history_entries_owner_jurisdiction_recent_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "search_history_entries_owner_jurisdiction_recent_idx"
  ON "search_history_entries" ("organization_id", "user_id", "jurisdiction", "last_used_at", "id");
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
