SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Give every remaining dual-column workspace table the composite reference
-- time_entries, office_file_evidence, and ai_memories already carry:
--
--   (workspace_id, organization_id) -> workspaces (id, organization_id)
--
-- A table that persists both columns states the same tenancy twice. Until now
-- only the two halves were checked separately: workspace_id had to name a real
-- workspace and organization_id a real organization, but nothing required the
-- workspace to belong to that organization. The pair reference makes the
-- disagreement unrepresentable, one layer below the org-pinned policies added
-- in 20260812110000 and the organization references added in 20260812170000.
-- It narrows nothing the application relies on: every writer already supplies
-- both scopes from the same scoped transaction (apps/api/src/db/scoped.ts).
--
-- The referenced side is workspaces_id_org_unq, the UNIQUE (id,
-- organization_id) constraint attached in 20260808008000.
--
-- ON DELETE mirrors each table's existing single-column workspace reference so
-- the pair never contradicts it: CASCADE where the workspace reference
-- cascades, RESTRICT for the two chat tables, whose rows are removed
-- explicitly before the workspace row (apps/api/src/handlers/workspaces/
-- delete.ts). Four tables with both columns are deliberately excluded:
--
--   audit_logs
--     The matter-delete transaction removes the workspace row and then records
--     the DELETE audit event for it. A reference from audit_logs to workspaces
--     would abort that insert, so the table carries no workspace reference at
--     all and its history outlives the matter it describes.
--
--   buffer_object_cleanup_intents, entity_deletion_cleanup_requests
--     Storage-erasure outboxes. Each row is the only surviving record of which
--     objects still have to be erased, so they reference no ancestor by
--     design. Guarded by apps/api/src/db/schema/entities.test.ts.
--
--   usage_events
--     Organization-owned metering ledger whose workspace_id is nullable
--     attribution: the single-column reference is ON DELETE SET NULL so a row
--     survives the matter it was attributed to. The pair would need
--     ON DELETE SET NULL (workspace_id), a column list drizzle 1.0.0-rc.4
--     cannot declare, so the migration and the model would disagree. Adding it
--     becomes correct once that column list is expressible.
--
-- Every constraint is NOT VALID here: the ADD then takes a brief ACCESS
-- EXCLUSIVE lock and writes catalog rows without scanning, and enforcement is
-- immediate for new and updated rows. The existing rows are validated by the
-- separate migrations that follow, each in its own migrator transaction, so a
-- scan that times out is retryable and localized to one table.
--
-- Constraint names are explicit rather than drizzle-generated, and every one
-- fits PostgreSQL's 63-byte identifier limit. Each statement is one line
-- because squawk anchors a suppression to the line directly above the
-- statement it reports.

ALTER TABLE "anonymization_allowlist_entries" ADD CONSTRAINT "anonymization_allowlist_entries_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces" ("id", "organization_id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint

ALTER TABLE "anonymization_blacklist_entries" ADD CONSTRAINT "anonymization_blacklist_entries_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces" ("id", "organization_id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint

ALTER TABLE "billing_codes" ADD CONSTRAINT "billing_codes_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces" ("id", "organization_id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint

ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces" ("id", "organization_id") ON DELETE RESTRICT NOT VALID;--> statement-breakpoint

ALTER TABLE "chat_turns" ADD CONSTRAINT "chat_turns_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces" ("id", "organization_id") ON DELETE RESTRICT NOT VALID;--> statement-breakpoint

ALTER TABLE "document_processing_runs" ADD CONSTRAINT "document_processing_runs_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces" ("id", "organization_id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint

ALTER TABLE "document_review_findings" ADD CONSTRAINT "document_review_findings_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces" ("id", "organization_id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint

ALTER TABLE "document_review_runs" ADD CONSTRAINT "document_review_runs_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces" ("id", "organization_id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint

ALTER TABLE "entity_version_ai_summaries" ADD CONSTRAINT "entity_version_ai_summaries_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces" ("id", "organization_id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint

ALTER TABLE "expenses" ADD CONSTRAINT "expenses_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces" ("id", "organization_id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint

ALTER TABLE "extracted_content" ADD CONSTRAINT "extracted_content_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces" ("id", "organization_id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint

ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces" ("id", "organization_id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint

ALTER TABLE "file_chat_threads" ADD CONSTRAINT "file_chat_threads_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces" ("id", "organization_id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint

ALTER TABLE "invoices" ADD CONSTRAINT "invoices_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces" ("id", "organization_id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint

ALTER TABLE "pending_uploads" ADD CONSTRAINT "pending_uploads_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces" ("id", "organization_id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint

ALTER TABLE "rate_tables" ADD CONSTRAINT "rate_tables_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces" ("id", "organization_id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint

ALTER TABLE "search_document_preview_passages" ADD CONSTRAINT "search_document_preview_passages_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces" ("id", "organization_id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint

ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces" ("id", "organization_id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint

ALTER TABLE "template_persistence_requests" ADD CONSTRAINT "template_persistence_requests_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces" ("id", "organization_id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint

ALTER TABLE "workspace_contacts" ADD CONSTRAINT "workspace_contacts_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces" ("id", "organization_id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint

ALTER TABLE "workspace_search_document_preview_passages" ADD CONSTRAINT "workspace_search_document_preview_passages_workspace_org_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces" ("id", "organization_id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint

ALTER TABLE "workspace_search_documents" ADD CONSTRAINT "workspace_search_documents_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces" ("id", "organization_id") ON DELETE CASCADE NOT VALID;
