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
ALTER TABLE "invoices" VALIDATE CONSTRAINT "invoices_original_invoice_workspace_fk";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Validation runs outside the DDL transaction so scans do not retain DDL locks.
ALTER TABLE "invoices" VALIDATE CONSTRAINT "invoices_document_type_check";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Validation runs outside the DDL transaction so scans do not retain DDL locks.
ALTER TABLE "invoices" VALIDATE CONSTRAINT "invoices_original_invoice_check";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- Validation runs outside the DDL transaction so scans do not retain DDL locks.
ALTER TABLE "invoice_lines" VALIDATE CONSTRAINT "invoice_lines_amounts_check";
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;

