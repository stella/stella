-- requires: 20261003122900_billing_modes
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
-- Replayable index build uses the guarded concurrent-index protocol.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "rate_entries_table_role_from_idx" ON "rate_entries" ("rate_table_id", "role", "effective_from");
--> statement-breakpoint
REINDEX INDEX CONCURRENTLY "rate_entries_table_role_from_idx";
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
