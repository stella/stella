CREATE TABLE "chat_thread_search_documents" (
	"thread_id" uuid PRIMARY KEY,
	"title" text DEFAULT '' NOT NULL,
	"searchable_text" text DEFAULT '' NOT NULL,
	"tsv" tsvector,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_thread_search_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chat_thread_search_documents" TO stella;--> statement-breakpoint
CREATE INDEX "chat_thread_search_docs_tsv_idx" ON "chat_thread_search_documents" USING gin ("tsv");--> statement-breakpoint
ALTER TABLE "chat_thread_search_documents" ADD CONSTRAINT "chat_thread_search_documents_thread_id_chat_threads_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "chat_threads"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "chat_thread_search_document_select" ON "chat_thread_search_documents" AS PERMISSIVE FOR SELECT TO "stella" USING (EXISTS (
    SELECT 1 FROM chat_threads ct
    WHERE ct.id = chat_thread_search_documents.thread_id
      AND ct.user_id = (SELECT current_setting(
        'app.user_id', true
      ))
      AND ct.organization_id = (SELECT current_setting(
        'app.organization_id', true
      ))
      AND (ct.workspace_id IS NULL OR ct.workspace_id = ANY((SELECT current_setting(
        'app.workspace_ids', true
      ))::uuid[]))
      AND (
        cardinality(ct.data_workspace_ids) = 0
        OR ct.data_workspace_ids <@ (SELECT current_setting(
          'app.workspace_ids', true
        ))::uuid[]
      )
  ));--> statement-breakpoint
CREATE POLICY "chat_thread_search_document_insert" ON "chat_thread_search_documents" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (EXISTS (
    SELECT 1 FROM chat_threads ct
    WHERE ct.id = chat_thread_search_documents.thread_id
      AND ct.user_id = (SELECT current_setting(
        'app.user_id', true
      ))
      AND ct.organization_id = (SELECT current_setting(
        'app.organization_id', true
      ))
      AND (ct.workspace_id IS NULL OR ct.workspace_id = ANY((SELECT current_setting(
        'app.workspace_ids', true
      ))::uuid[]))
      AND (
        cardinality(ct.data_workspace_ids) = 0
        OR ct.data_workspace_ids <@ (SELECT current_setting(
          'app.workspace_ids', true
        ))::uuid[]
      )
  ));--> statement-breakpoint
CREATE POLICY "chat_thread_search_document_update" ON "chat_thread_search_documents" AS PERMISSIVE FOR UPDATE TO "stella" USING (EXISTS (
    SELECT 1 FROM chat_threads ct
    WHERE ct.id = chat_thread_search_documents.thread_id
      AND ct.user_id = (SELECT current_setting(
        'app.user_id', true
      ))
      AND ct.organization_id = (SELECT current_setting(
        'app.organization_id', true
      ))
      AND (ct.workspace_id IS NULL OR ct.workspace_id = ANY((SELECT current_setting(
        'app.workspace_ids', true
      ))::uuid[]))
      AND (
        cardinality(ct.data_workspace_ids) = 0
        OR ct.data_workspace_ids <@ (SELECT current_setting(
          'app.workspace_ids', true
        ))::uuid[]
      )
  ));--> statement-breakpoint
CREATE POLICY "chat_thread_search_document_delete" ON "chat_thread_search_documents" AS PERMISSIVE FOR DELETE TO "stella" USING (EXISTS (
    SELECT 1 FROM chat_threads ct
    WHERE ct.id = chat_thread_search_documents.thread_id
      AND ct.user_id = (SELECT current_setting(
        'app.user_id', true
      ))
      AND ct.organization_id = (SELECT current_setting(
        'app.organization_id', true
      ))
      AND (ct.workspace_id IS NULL OR ct.workspace_id = ANY((SELECT current_setting(
        'app.workspace_ids', true
      ))::uuid[]))
      AND (
        cardinality(ct.data_workspace_ids) = 0
        OR ct.data_workspace_ids <@ (SELECT current_setting(
          'app.workspace_ids', true
        ))::uuid[]
      )
  ));
