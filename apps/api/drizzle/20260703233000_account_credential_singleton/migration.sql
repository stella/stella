SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
-- The migration runner preserves a valid index and concurrently repairs an
-- interrupted INVALID build before reporting completion.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "account_credential_singleton_uidx" ON "account" ("provider_id") WHERE provider_id = 'credential';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
--> statement-breakpoint
SET statement_timeout = '5s';
