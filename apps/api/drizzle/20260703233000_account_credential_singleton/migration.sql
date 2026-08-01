SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - retry cleanup drops only this migration's index before rebuilding it, so an interrupted INVALID index cannot be mistaken for completion.
DROP INDEX CONCURRENTLY IF EXISTS "account_credential_singleton_uidx";
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "account_credential_singleton_uidx" ON "account" ("provider_id") WHERE provider_id = 'credential';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
--> statement-breakpoint
SET statement_timeout = '5s';
