SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint

-- What a document is to one list's facts: a record of what happened or a
-- person's account of it. A new, empty table; a document without a row is
-- a record.
CREATE TABLE "legal_list_source_documents" (
  "entity_feature_gate" text DEFAULT 'pending' NOT NULL,
  "workspace_id" uuid NOT NULL,
  "list_id" uuid NOT NULL,
  "document_entity_id" uuid NOT NULL,
  "source_kind" text NOT NULL,
  "updated_by" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "legal_list_source_documents_pkey" PRIMARY KEY ("list_id", "document_entity_id"),
  CONSTRAINT "legal_list_source_documents_source_kind_check" CHECK ("source_kind" in ('document', 'testimony')),
  CONSTRAINT "legal_list_source_documents_list_fk" FOREIGN KEY ("list_id", "workspace_id") REFERENCES "legal_lists"("id", "workspace_id") ON DELETE CASCADE,
  CONSTRAINT "legal_list_source_documents_document_fk" FOREIGN KEY ("document_entity_id", "workspace_id") REFERENCES "entities"("id", "workspace_id") ON DELETE CASCADE,
  CONSTRAINT "legal_list_source_documents_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE SET NULL
);--> statement-breakpoint
-- Built with the empty table, so nothing is scanned; the feature gate finds
-- a document's rows through it.
CREATE INDEX "legal_list_source_documents_ef_document_entity_id_idx" ON "legal_list_source_documents" ("workspace_id", "document_entity_id");--> statement-breakpoint

ALTER TABLE "legal_list_source_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legal_list_source_documents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "legal_list_source_documents" TO stella;--> statement-breakpoint

CREATE POLICY "workspace_select" ON "legal_list_source_documents"
  AS PERMISSIVE FOR SELECT TO stella USING ((CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true
    ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
  END));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "legal_list_source_documents"
  AS PERMISSIVE FOR INSERT TO stella WITH CHECK ((CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true
    ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
  END));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "legal_list_source_documents"
  AS PERMISSIVE FOR UPDATE TO stella USING ((CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true
    ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
  END));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "legal_list_source_documents"
  AS PERMISSIVE FOR DELETE TO stella USING ((CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true
    ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
  END));--> statement-breakpoint
CREATE POLICY "legal_list_source_documents_owner_access" ON "legal_list_source_documents"
  AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.legal_list_source_documents'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.legal_list_source_documents'::regclass));
