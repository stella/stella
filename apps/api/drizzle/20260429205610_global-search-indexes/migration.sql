CREATE TABLE "contact_search_documents" (
	"contact_id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"contact_type" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"searchable_text" text DEFAULT '' NOT NULL,
	"tsv" tsvector,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contact_search_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workspace_search_documents" (
	"workspace_id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"searchable_text" text DEFAULT '' NOT NULL,
	"tsv" tsvector,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_search_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "extracted_content" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "search_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "contact_search_docs_org_idx" ON "contact_search_documents" ("organization_id");--> statement-breakpoint
CREATE INDEX "contact_search_docs_org_type_idx" ON "contact_search_documents" ("organization_id","contact_type");--> statement-breakpoint
CREATE INDEX "contact_search_docs_tsv_idx" ON "contact_search_documents" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "workspace_search_docs_org_idx" ON "workspace_search_documents" ("organization_id");--> statement-breakpoint
CREATE INDEX "workspace_search_docs_tsv_idx" ON "workspace_search_documents" USING gin ("tsv");--> statement-breakpoint
ALTER TABLE "contact_search_documents" ADD CONSTRAINT "contact_search_documents_contact_id_contacts_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "contact_search_documents" ADD CONSTRAINT "contact_search_documents_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_search_documents" ADD CONSTRAINT "workspace_search_documents_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_search_documents" ADD CONSTRAINT "workspace_search_documents_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "organization_select" ON "contact_search_documents" AS PERMISSIVE FOR SELECT TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_insert" ON "contact_search_documents" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_update" ON "contact_search_documents" AS PERMISSIVE FOR UPDATE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_delete" ON "contact_search_documents" AS PERMISSIVE FOR DELETE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "workspace_select" ON "extracted_content" AS PERMISSIVE FOR SELECT TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "extracted_content" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "extracted_content" AS PERMISSIVE FOR UPDATE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "extracted_content" AS PERMISSIVE FOR DELETE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_select" ON "search_documents" AS PERMISSIVE FOR SELECT TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "search_documents" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "search_documents" AS PERMISSIVE FOR UPDATE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "search_documents" AS PERMISSIVE FOR DELETE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_select" ON "workspace_search_documents" AS PERMISSIVE FOR SELECT TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "workspace_search_documents" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "workspace_search_documents" AS PERMISSIVE FOR UPDATE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "workspace_search_documents" AS PERMISSIVE FOR DELETE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));