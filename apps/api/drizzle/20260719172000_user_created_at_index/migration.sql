SET lock_timeout = '2s';
--> statement-breakpoint
SET statement_timeout = '0';
--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
-- The runner validates this index and concurrently repairs an INVALID build.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "user_createdAt_idx" ON "user" USING btree ("created_at","id");
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
--> statement-breakpoint
SET statement_timeout = DEFAULT;
