SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- ai_memories can grow with chat usage, so build the account-deletion lookup
-- without blocking writes. Drizzle wraps pending migrations in a transaction;
-- split it for PostgreSQL's concurrent index protocol, then reopen it for the
-- migration ledger write.
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - drops only this migration's index name, and only to repair an INVALID index left by an interrupted concurrent build; the next statement rebuilds it before completion.
DROP INDEX CONCURRENTLY IF EXISTS "ai_memories_created_by_status_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "ai_memories_created_by_status_idx" ON "ai_memories" USING btree ("created_by", "status") WHERE "created_by" IS NOT NULL;
--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
