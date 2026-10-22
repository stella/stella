-- requires: 20261022120000_contact_tenant_references
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint

-- Validate the organization-bound contact references added in
-- 20261022120000. Every table here is bounded by an organization's contacts
-- or matters, not by document volume, so the five scans share one
-- transaction. VALIDATE takes SHARE UPDATE EXCLUSIVE, so concurrent writers
-- keep running; a row whose contact belongs to another organization fails the
-- scan, which leaves the constraint NOT VALID and is repaired before a rerun.

ALTER TABLE "contact_relationships" VALIDATE CONSTRAINT "contact_relationships_person_fk";--> statement-breakpoint

ALTER TABLE "contact_relationships" VALIDATE CONSTRAINT "contact_relationships_related_contact_fk";--> statement-breakpoint

ALTER TABLE "contact_search_documents" VALIDATE CONSTRAINT "contact_search_documents_contact_fk";--> statement-breakpoint

ALTER TABLE "workspace_contacts" VALIDATE CONSTRAINT "workspace_contacts_contact_fk";--> statement-breakpoint

ALTER TABLE "workspaces" VALIDATE CONSTRAINT "workspaces_client_fk";
