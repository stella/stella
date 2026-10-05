-- requires: 20261005184900_case_law_source_lease_purpose
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Validate outside the DDL transaction so the scan does not retain its locks.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

ALTER TABLE "case_law_sources"
  -- squawk-ignore prefer-robust-stmts -- Validates the check from the preceding migration outside the DDL transaction.
  VALIDATE CONSTRAINT "case_law_sources_ingestion_lease_purpose_valid";
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
