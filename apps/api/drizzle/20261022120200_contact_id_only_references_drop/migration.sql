-- requires: 20261022120100_contact_tenant_references_validate
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Drop the id-only contact references. Each is implied by the validated
-- organization-bound reference with the same ON DELETE action
-- (20261022120000, 20261022120100), so no row loses a check and no delete
-- changes behaviour. The application never names these constraints.

-- stella-migration-safety: reviewed drop-constraint - Implied by the validated (organization_id, person_id) and (organization_id, related_contact_id) references with the same ON DELETE CASCADE; no data changes.
ALTER TABLE "contact_relationships" DROP CONSTRAINT "contact_relationships_person_id_contacts_id_fkey", DROP CONSTRAINT "contact_relationships_related_contact_id_contacts_id_fkey";--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - Implied by the validated contact_search_documents_contact_fk with the same ON DELETE CASCADE; no data changes.
ALTER TABLE "contact_search_documents" DROP CONSTRAINT "contact_search_documents_contact_id_contacts_id_fkey";--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - Implied by the validated workspace_contacts_contact_fk with the same ON DELETE CASCADE; no data changes.
ALTER TABLE "workspace_contacts" DROP CONSTRAINT "workspace_contacts_contact_id_contacts_id_fkey";--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - Implied by the validated workspaces_client_fk with the same ON DELETE RESTRICT; no data changes.
ALTER TABLE "workspaces" DROP CONSTRAINT "workspaces_client_id_contacts_id_fkey";
