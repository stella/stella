-- requires: 20261003124800_registration_retention
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "oauth_client_registration_retention_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "oauth_client_registration_retention_idx" ON "oauth_client" ("updated_at", "client_id") WHERE registration_origin IN ('open-client', 'agent') OR client_discovery_id IS NOT NULL;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "verification_expires_at_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "verification_expires_at_idx" ON "verification" ("expires_at");
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "agent_registration_expiry_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "agent_registration_expiry_idx" ON "agent_registration" ("expires_at", "id") WHERE status IN ('pending', 'expired') AND bound_user_id IS NULL AND authorization_code IS NULL;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "agent_registration_client_id_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "agent_registration_client_id_idx" ON "agent_registration" ("client_id");
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "oauth_client_assertion_expires_at_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "oauth_client_assertion_expires_at_idx" ON "oauth_client_assertion" ("expires_at");
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
ALTER TABLE "oauth_client" VALIDATE CONSTRAINT "oauth_client_registration_origin_check";
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
