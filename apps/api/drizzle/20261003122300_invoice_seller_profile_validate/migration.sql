SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Validate outside the DDL transaction so the scan does not retain the locks
-- taken while adding the constraint. Restore bounded timeouts before
-- reopening a transaction for the migrator's bookkeeping row.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

ALTER TABLE "invoices"
  -- squawk-ignore prefer-robust-stmts -- Validates the NOT VALID foreign key from the preceding migration outside the DDL transaction.
  VALIDATE CONSTRAINT "invoices_seller_profile_id_seller_profiles_id_fk";
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
