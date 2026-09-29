SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

ALTER TABLE "invoices"
  ADD COLUMN "document_type" text DEFAULT 'invoice' NOT NULL,
  ADD COLUMN "original_invoice_id" uuid,
  ADD COLUMN "finalized_at" timestamptz;--> statement-breakpoint

-- Pre-public; migration writes no NULLs; only new-code drafts omit numbers, and web/CLI/MCP ship in the same release.
-- squawk-ignore ban-drop-not-null
ALTER TABLE "invoices" ALTER COLUMN "invoice_number" DROP NOT NULL;--> statement-breakpoint

-- Build the self-reference key and lookup index without holding the DDL
-- transaction's locks through the scans.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "invoices_id_workspace_unique";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE UNIQUE INDEX CONCURRENTLY "invoices_id_workspace_unique" ON "invoices" ("id", "workspace_id");
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "invoices_ws_original_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "invoices_ws_original_idx" ON "invoices" ("workspace_id", "original_invoice_id");
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_id_workspace_unique" UNIQUE USING INDEX "invoices_id_workspace_unique";--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_original_invoice_workspace_fk" FOREIGN KEY ("original_invoice_id", "workspace_id") REFERENCES "invoices"("id", "workspace_id") NOT VALID;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_document_type_check" CHECK ("document_type" IN ('invoice', 'advance', 'credit_note')) NOT VALID;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_original_invoice_check" CHECK (("document_type" = 'credit_note') = ("original_invoice_id" IS NOT NULL) AND ("original_invoice_id" IS NULL OR "original_invoice_id" <> "id")) NOT VALID;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - Replaces the nonnegative amount guard atomically with a same-sign guard that permits credit-note amounts while retaining quantity, price, and sum checks.
ALTER TABLE "invoice_lines" DROP CONSTRAINT "invoice_lines_amounts_check";--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_amounts_check" CHECK ("quantity" >= 0 AND "unit_price" >= 0 AND (("net_amount" >= 0 AND "vat_amount" >= 0) OR ("net_amount" <= 0 AND "vat_amount" <= 0)) AND "gross_amount" = "net_amount" + "vat_amount") NOT VALID;--> statement-breakpoint
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

