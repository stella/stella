SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5min';--> statement-breakpoint
-- The preceding migration has committed its catalog swaps. Validation uses
-- SHARE UPDATE EXCLUSIVE, allowing ordinary invoice reads and writes.
ALTER TABLE "invoices" VALIDATE CONSTRAINT "invoices_workspace_id_workspaces_id_fkey";--> statement-breakpoint
ALTER TABLE "invoices" VALIDATE CONSTRAINT "invoices_workspace_organization_fk";--> statement-breakpoint
ALTER TABLE "invoice_lines" VALIDATE CONSTRAINT "invoice_lines_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "invoice_lines" VALIDATE CONSTRAINT "invoice_lines_workspace_organization_fk";
