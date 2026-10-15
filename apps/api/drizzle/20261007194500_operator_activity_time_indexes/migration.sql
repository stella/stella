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

-- Rebuild this migration's indexes on retry, including cancelled INVALID builds.
DROP INDEX CONCURRENTLY IF EXISTS "chat_messages_created_at_brin_idx";
--> statement-breakpoint
-- BRIN bounds recent activity reads on the append-oriented global timelines.
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "chat_messages_created_at_brin_idx" ON "chat_messages" USING brin ("created_at");
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "audit_logs_created_at_brin_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "audit_logs_created_at_brin_idx" ON "audit_logs" USING brin ("created_at");
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
