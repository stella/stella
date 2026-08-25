SET lock_timeout = '2s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

-- The trusted backfill has already proved every existing (issuer, account_id)
-- pair is complete and collision-free. Build the new identity key without
-- blocking reads or writes; the deployment runbook keeps application writers
-- scaled to zero until the 1.7 image is ready.
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
  "account_issuer_account_id_uidx"
  ON "account" ("issuer", "account_id");--> statement-breakpoint
-- An interrupted concurrent build leaves an INVALID index that IF NOT EXISTS
-- would otherwise accept on retry. Reindexing is the online validity repair.
REINDEX INDEX CONCURRENTLY "account_issuer_account_id_uidx";--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;--> statement-breakpoint
SET lock_timeout = '2s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

-- This is deliberately fail-closed. An accidental candidate deploy before
-- the sealed backfill leaves NULL issuers and must stop here rather than start
-- Better Auth 1.7 against ambiguous account identities.
ALTER TABLE "account"
  ADD CONSTRAINT "account_issuer_not_null_check"
  CHECK ("issuer" IS NOT NULL) NOT VALID;--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;--> statement-breakpoint
SET lock_timeout = '2s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "account"
  VALIDATE CONSTRAINT "account_issuer_not_null_check";--> statement-breakpoint
-- The validated check lets PostgreSQL promote the column without a table scan.
-- squawk-ignore adding-not-nullable-field
ALTER TABLE "account"
  ALTER COLUMN "issuer" SET NOT NULL;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - This removes only the
-- temporary validation proof after equivalent NOT NULL metadata is recorded;
-- rollback can recreate the check without changing row data.
ALTER TABLE "account"
  DROP CONSTRAINT "account_issuer_not_null_check";
