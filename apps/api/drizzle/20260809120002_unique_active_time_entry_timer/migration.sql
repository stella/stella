SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint

-- Enforce the one-running-timer invariant at the persistence boundary. Build
-- concurrently so existing time-entry reads and writes continue during setup.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - retry cleanup only;
-- a cancelled concurrent build can leave an INVALID index with this name.
DROP INDEX CONCURRENTLY IF EXISTS "time_entries_one_active_timer_per_user_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- A failed concurrent build must be replaced, not retained as INVALID.
CREATE UNIQUE INDEX CONCURRENTLY "time_entries_one_active_timer_per_user_idx"
  ON "time_entries" ("user_id")
  WHERE "timer_started_at" IS NOT NULL;
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
