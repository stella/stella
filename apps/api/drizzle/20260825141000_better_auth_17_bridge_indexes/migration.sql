SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- These indexes target token tables already serving Better Auth 1.6 traffic.
-- Drizzle wraps migrations in a transaction, while PostgreSQL requires
-- concurrent index builds to run outside one. Split the transaction so the
-- bridge never blocks token writes for the duration of an index scan.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint

DROP INDEX CONCURRENTLY IF EXISTS "oauth_refresh_token_authorization_code_id_idx";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- IF NOT EXISTS would retain an INVALID index left by an interrupted concurrent build
CREATE INDEX CONCURRENTLY "oauth_refresh_token_authorization_code_id_idx"
  ON "oauth_refresh_token" ("authorization_code_id");--> statement-breakpoint

DROP INDEX CONCURRENTLY IF EXISTS "oauth_access_token_authorization_code_id_idx";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- IF NOT EXISTS would retain an INVALID index left by an interrupted concurrent build
CREATE INDEX CONCURRENTLY "oauth_access_token_authorization_code_id_idx"
  ON "oauth_access_token" ("authorization_code_id");--> statement-breakpoint

SET statement_timeout = '5s';--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
