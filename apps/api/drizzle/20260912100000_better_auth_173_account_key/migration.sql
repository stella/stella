SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Better Auth 1.7.3 restored (provider_id, account_id) as the account key and
-- no longer writes issuer. Remove the 1.7.0-1.7.2 uniqueness rule first: new
-- rows have a NULL issuer, so retaining it would enforce the wrong identity.
-- The account table is write-hot, so release the migrator transaction and
-- drop the obsolete index without blocking reads or writes.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Better Auth 1.7.3
-- removed issuer from account identity; rollback can recreate this index only
-- after every account has a trusted issuer again.
DROP INDEX CONCURRENTLY IF EXISTS "account_issuer_account_id_uidx";--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Keep historical issuer values for rollout compatibility, but permit the new
-- application version to insert accounts without a field it no longer writes.
-- squawk-ignore ban-drop-not-null
ALTER TABLE "account" ALTER COLUMN "issuer" DROP NOT NULL;
