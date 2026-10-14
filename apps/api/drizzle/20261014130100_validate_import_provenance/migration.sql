-- requires: 20261014130000_import_provenance
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

-- Validate without retaining the constraint DDL locks through the scans.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Validation runs outside the DDL transaction so scans do not retain DDL locks.
ALTER TABLE "contacts" VALIDATE CONSTRAINT "contacts_external_ref_check";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Validation runs outside the DDL transaction so scans do not retain DDL locks.
ALTER TABLE "workspaces" VALIDATE CONSTRAINT "workspaces_external_ref_check";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Validation runs outside the DDL transaction so scans do not retain DDL locks.
ALTER TABLE "time_entries" VALIDATE CONSTRAINT "time_entries_external_ref_check";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Validation runs outside the DDL transaction so scans do not retain DDL locks.
ALTER TABLE "expenses" VALIDATE CONSTRAINT "expenses_external_ref_check";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Validation runs outside the DDL transaction so scans do not retain DDL locks.
ALTER TABLE "invoices" VALIDATE CONSTRAINT "invoices_external_ref_check";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Validation runs outside the DDL transaction so scans do not retain DDL locks.
ALTER TABLE "correspondence" VALIDATE CONSTRAINT "correspondence_external_ref_check";
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
