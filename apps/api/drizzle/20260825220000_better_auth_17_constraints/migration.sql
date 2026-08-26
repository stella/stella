SET lock_timeout = '2s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

-- Refuse the cutover before committing any constraint state or index work when
-- the trusted backfill is incomplete. DROP + ADD makes every later retry
-- converge if an earlier run committed this check but stopped before Drizzle
-- recorded the migration receipt. The operational write freeze prevents a new
-- NULL between this precondition and the constraint becoming enforced.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "account" WHERE "issuer" IS NULL) THEN
    RAISE EXCEPTION 'account_issuer_not_null_check: issuer backfill is incomplete';
  END IF;
END
$$;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - Retry cleanup removes
-- only this migration's temporary validation proof and recreates it below in
-- the same transaction.
ALTER TABLE "account"
  DROP CONSTRAINT IF EXISTS "account_issuer_not_null_check";--> statement-breakpoint
ALTER TABLE "account"
  ADD CONSTRAINT "account_issuer_not_null_check"
  CHECK ("issuer" IS NOT NULL) NOT VALID;--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint

-- Validate outside the ADD CONSTRAINT transaction so the table scan does not
-- hold the stronger ADD lock. The NOT VALID check already rejects new NULLs.
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;--> statement-breakpoint
SET lock_timeout = '2s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "account"
  VALIDATE CONSTRAINT "account_issuer_not_null_check";--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint

-- The validated check proves every existing identity has an issuer. Build the
-- unique identity key without blocking reads or writes; the deployment runbook
-- keeps application writers frozen until the 1.7 image is ready.
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
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
-- The validated check lets PostgreSQL promote the column without a table scan.
-- squawk-ignore adding-not-nullable-field
ALTER TABLE "account"
  ALTER COLUMN "issuer" SET NOT NULL;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - This removes only the
-- temporary validation proof after equivalent NOT NULL metadata is recorded;
-- rollback can recreate the check without changing row data.
ALTER TABLE "account"
  DROP CONSTRAINT "account_issuer_not_null_check";
