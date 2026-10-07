SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Concurrent builds run outside the migrator transaction.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

-- Rebuild this migration's index on retry, including a cancelled INVALID build.
DROP INDEX CONCURRENTLY IF EXISTS "chat_turns_created_at_idx";
--> statement-breakpoint
-- The operator aggregate spans organizations and filters only creation time.
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "chat_turns_created_at_idx" ON "chat_turns" ("created_at");
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
