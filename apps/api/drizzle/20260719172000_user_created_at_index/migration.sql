SET lock_timeout = '2s';
--> statement-breakpoint
SET statement_timeout = '0';
--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - retry cleanup drops only this migration's index if a cancelled concurrent build left an invalid index behind; no table data is removed.
DROP INDEX CONCURRENTLY IF EXISTS "user_createdAt_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "user_createdAt_idx" ON "user" USING btree ("created_at","id");
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
