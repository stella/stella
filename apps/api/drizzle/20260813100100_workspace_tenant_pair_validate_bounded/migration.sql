SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint

-- Validate the tenant-pair references added in 20260813100000 for the tables
-- whose row count is bounded by tenant, matter, or billing-document count
-- rather than by document volume. Eleven scans share one transaction because
-- each is small; the tables that scale with the corpus get one migration each,
-- so a timeout there names the table it happened on and is retried alone.
--
-- The split from the ADD is what matters: VALIDATE runs here in its own
-- migrator transaction and takes SHARE UPDATE EXCLUSIVE, so it does not
-- inherit the ACCESS EXCLUSIVE lock the ADD took and concurrent writers keep
-- running. Same shape as 20260808008000 and 20260808009000 for ai_memories.

ALTER TABLE "anonymization_allowlist_entries" VALIDATE CONSTRAINT "anonymization_allowlist_entries_workspace_organization_fk";--> statement-breakpoint

ALTER TABLE "anonymization_blacklist_entries" VALIDATE CONSTRAINT "anonymization_blacklist_entries_workspace_organization_fk";--> statement-breakpoint

ALTER TABLE "billing_codes" VALIDATE CONSTRAINT "billing_codes_workspace_organization_fk";--> statement-breakpoint

ALTER TABLE "document_review_runs" VALIDATE CONSTRAINT "document_review_runs_workspace_organization_fk";--> statement-breakpoint

ALTER TABLE "expenses" VALIDATE CONSTRAINT "expenses_workspace_organization_fk";--> statement-breakpoint

ALTER TABLE "extraction_runs" VALIDATE CONSTRAINT "extraction_runs_workspace_organization_fk";--> statement-breakpoint

ALTER TABLE "file_chat_threads" VALIDATE CONSTRAINT "file_chat_threads_workspace_organization_fk";--> statement-breakpoint

ALTER TABLE "invoices" VALIDATE CONSTRAINT "invoices_workspace_organization_fk";--> statement-breakpoint

ALTER TABLE "rate_tables" VALIDATE CONSTRAINT "rate_tables_workspace_organization_fk";--> statement-breakpoint

ALTER TABLE "template_persistence_requests" VALIDATE CONSTRAINT "template_persistence_requests_workspace_organization_fk";--> statement-breakpoint

ALTER TABLE "workspace_contacts" VALIDATE CONSTRAINT "workspace_contacts_workspace_organization_fk";
