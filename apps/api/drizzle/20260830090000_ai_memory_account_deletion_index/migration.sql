SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- ai_memories can grow with chat usage, so build the account-deletion lookup
-- without blocking writes. Drizzle wraps pending migrations in a transaction;
-- split it for PostgreSQL's concurrent index protocol, then reopen it for the
-- migration ledger write.
SET statement_timeout = '30min';--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "ai_memories_created_by_status_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "ai_memories_created_by_status_idx" ON "ai_memories" USING btree ("created_by", "status") WHERE "created_by" IS NOT NULL;
--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
