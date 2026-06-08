CREATE TABLE "chat_message_search_documents" (
	"message_id" uuid PRIMARY KEY,
	"thread_id" uuid NOT NULL,
	"role" varchar(16) NOT NULL,
	"searchable_text" text DEFAULT '' NOT NULL,
	"tsv" tsvector,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_thread_compactions" (
	"id" uuid PRIMARY KEY,
	"thread_id" uuid NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"summary" jsonb NOT NULL,
	"summary_markdown" text NOT NULL,
	"first_summarized_message_id" uuid NOT NULL,
	"last_summarized_message_id" uuid NOT NULL,
	"first_kept_message_id" uuid NOT NULL,
	"summarized_message_count" integer NOT NULL,
	"total_tokens" integer NOT NULL,
	"preserved_tokens" integer NOT NULL,
	"prompt_version" smallint NOT NULL,
	"model_provider" text,
	"model_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_message_search_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_thread_compactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chat_message_search_documents" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chat_thread_compactions" TO stella;--> statement-breakpoint
CREATE INDEX "chat_message_search_docs_tsv_idx" ON "chat_message_search_documents" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "chat_message_search_docs_thread_created_idx" ON "chat_message_search_documents" ("thread_id", "created_at", "message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_thread_compactions_active_thread_uidx" ON "chat_thread_compactions" ("thread_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "chat_thread_compactions_thread_status_created_idx" ON "chat_thread_compactions" ("thread_id", "status", "created_at");--> statement-breakpoint
ALTER TABLE "chat_message_search_documents" ADD CONSTRAINT "chat_message_search_documents_message_id_chat_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "chat_messages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_message_search_documents" ADD CONSTRAINT "chat_message_search_documents_thread_id_chat_threads_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "chat_threads"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_thread_compactions" ADD CONSTRAINT "chat_thread_compactions_thread_id_chat_threads_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "chat_threads"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_thread_compactions" ADD CONSTRAINT "chat_thread_compactions_first_summarized_message_id_chat_messages_id_fkey" FOREIGN KEY ("first_summarized_message_id") REFERENCES "chat_messages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_thread_compactions" ADD CONSTRAINT "chat_thread_compactions_last_summarized_message_id_chat_messages_id_fkey" FOREIGN KEY ("last_summarized_message_id") REFERENCES "chat_messages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_thread_compactions" ADD CONSTRAINT "chat_thread_compactions_first_kept_message_id_chat_messages_id_fkey" FOREIGN KEY ("first_kept_message_id") REFERENCES "chat_messages"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "chat_message_search_document_select" ON "chat_message_search_documents" AS PERMISSIVE FOR SELECT TO "stella" USING (EXISTS (
    SELECT 1 FROM chat_threads ct
    WHERE ct.id = chat_message_search_documents.thread_id
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
CREATE POLICY "chat_message_search_document_insert" ON "chat_message_search_documents" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (EXISTS (
    SELECT 1 FROM chat_threads ct
    WHERE ct.id = chat_message_search_documents.thread_id
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
CREATE POLICY "chat_message_search_document_update" ON "chat_message_search_documents" AS PERMISSIVE FOR UPDATE TO "stella" USING (EXISTS (
    SELECT 1 FROM chat_threads ct
    WHERE ct.id = chat_message_search_documents.thread_id
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
CREATE POLICY "chat_message_search_document_delete" ON "chat_message_search_documents" AS PERMISSIVE FOR DELETE TO "stella" USING (EXISTS (
    SELECT 1 FROM chat_threads ct
    WHERE ct.id = chat_message_search_documents.thread_id
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
CREATE POLICY "chat_thread_compaction_select" ON "chat_thread_compactions" AS PERMISSIVE FOR SELECT TO "stella" USING (EXISTS (
    SELECT 1 FROM chat_threads ct
    WHERE ct.id = chat_thread_compactions.thread_id
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
CREATE POLICY "chat_thread_compaction_insert" ON "chat_thread_compactions" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (EXISTS (
    SELECT 1 FROM chat_threads ct
    WHERE ct.id = chat_thread_compactions.thread_id
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
CREATE POLICY "chat_thread_compaction_update" ON "chat_thread_compactions" AS PERMISSIVE FOR UPDATE TO "stella" USING (EXISTS (
    SELECT 1 FROM chat_threads ct
    WHERE ct.id = chat_thread_compactions.thread_id
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
CREATE POLICY "chat_thread_compaction_delete" ON "chat_thread_compactions" AS PERMISSIVE FOR DELETE TO "stella" USING (EXISTS (
    SELECT 1 FROM chat_threads ct
    WHERE ct.id = chat_thread_compactions.thread_id
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
