SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "search_documents" ADD COLUMN "preview_generation" uuid;--> statement-breakpoint
ALTER TABLE "contact_search_documents" ADD COLUMN "preview_generation" uuid;--> statement-breakpoint
ALTER TABLE "workspace_search_documents" ADD COLUMN "preview_generation" uuid;--> statement-breakpoint
ALTER TABLE "chat_thread_search_documents" ADD COLUMN "preview_generation" uuid;--> statement-breakpoint
ALTER TABLE "case_law_search_documents" ADD COLUMN "preview_generation" uuid;--> statement-breakpoint

CREATE FUNCTION clear_search_preview_generation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.preview_generation := NULL;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER search_documents_clear_preview_generation
BEFORE UPDATE OF title, searchable_text, language ON search_documents
FOR EACH ROW EXECUTE FUNCTION clear_search_preview_generation();--> statement-breakpoint
CREATE TRIGGER contact_search_documents_clear_preview_generation
BEFORE UPDATE OF title, searchable_text ON contact_search_documents
FOR EACH ROW EXECUTE FUNCTION clear_search_preview_generation();--> statement-breakpoint
CREATE TRIGGER workspace_search_documents_clear_preview_generation
BEFORE UPDATE OF title, searchable_text ON workspace_search_documents
FOR EACH ROW EXECUTE FUNCTION clear_search_preview_generation();--> statement-breakpoint
CREATE TRIGGER chat_search_documents_clear_preview_generation
BEFORE UPDATE OF title, searchable_text ON chat_thread_search_documents
FOR EACH ROW EXECUTE FUNCTION clear_search_preview_generation();--> statement-breakpoint
CREATE TRIGGER case_law_search_documents_clear_preview_generation
BEFORE UPDATE OF title, searchable_text, language, regconfig
ON case_law_search_documents
FOR EACH ROW EXECUTE FUNCTION clear_search_preview_generation();--> statement-breakpoint

CREATE TABLE "search_document_preview_passages" (
  "entity_id" uuid NOT NULL REFERENCES "search_documents"("entity_id") ON DELETE CASCADE,
  "organization_id" varchar(128) NOT NULL,
  "workspace_id" uuid NOT NULL,
  "generation" uuid NOT NULL,
  "ordinal" integer NOT NULL,
  "content" text NOT NULL,
  "tsv" tsvector NOT NULL,
  CONSTRAINT "search_document_preview_passages_pk"
    PRIMARY KEY ("entity_id", "generation", "ordinal")
);--> statement-breakpoint
CREATE INDEX "search_doc_preview_passages_scope_idx"
  ON "search_document_preview_passages"
  ("organization_id", "workspace_id", "entity_id", "generation", "ordinal");--> statement-breakpoint
CREATE INDEX "search_doc_preview_passages_tsv_idx"
  ON "search_document_preview_passages" USING gin ("tsv");--> statement-breakpoint
ALTER TABLE "search_document_preview_passages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT ON TABLE "search_document_preview_passages" TO stella;--> statement-breakpoint
CREATE POLICY "search_document_preview_passages_workspace_select"
  ON "search_document_preview_passages" FOR SELECT TO stella
  USING (
    organization_id = (SELECT current_setting('app.organization_id', true))
    AND workspace_id = ANY(
      (SELECT current_setting('app.workspace_ids', true))::uuid[]
    )
  );--> statement-breakpoint
CREATE POLICY "search_document_preview_passages_no_insert"
  ON "search_document_preview_passages" AS RESTRICTIVE
  FOR INSERT TO stella WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "search_document_preview_passages_no_update"
  ON "search_document_preview_passages" AS RESTRICTIVE
  FOR UPDATE TO stella USING (false);--> statement-breakpoint
CREATE POLICY "search_document_preview_passages_no_delete"
  ON "search_document_preview_passages" AS RESTRICTIVE
  FOR DELETE TO stella USING (false);--> statement-breakpoint

CREATE TABLE "contact_search_document_preview_passages" (
  "contact_id" uuid NOT NULL REFERENCES "contact_search_documents"("contact_id") ON DELETE CASCADE,
  "organization_id" varchar(128) NOT NULL,
  "generation" uuid NOT NULL,
  "ordinal" integer NOT NULL,
  "content" text NOT NULL,
  "tsv" tsvector NOT NULL,
  CONSTRAINT "contact_search_document_preview_passages_pk"
    PRIMARY KEY ("contact_id", "generation", "ordinal")
);--> statement-breakpoint
CREATE INDEX "contact_preview_passages_scope_idx"
  ON "contact_search_document_preview_passages"
  ("organization_id", "contact_id", "generation", "ordinal");--> statement-breakpoint
CREATE INDEX "contact_preview_passages_tsv_idx"
  ON "contact_search_document_preview_passages" USING gin ("tsv");--> statement-breakpoint
ALTER TABLE "contact_search_document_preview_passages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT ON TABLE "contact_search_document_preview_passages" TO stella;--> statement-breakpoint
CREATE POLICY "contact_search_document_preview_passages_organization_select"
  ON "contact_search_document_preview_passages" FOR SELECT TO stella
  USING (
    organization_id = (SELECT current_setting('app.organization_id', true))
  );--> statement-breakpoint
CREATE POLICY "contact_search_document_preview_passages_no_insert"
  ON "contact_search_document_preview_passages" AS RESTRICTIVE
  FOR INSERT TO stella WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "contact_search_document_preview_passages_no_update"
  ON "contact_search_document_preview_passages" AS RESTRICTIVE
  FOR UPDATE TO stella USING (false);--> statement-breakpoint
CREATE POLICY "contact_search_document_preview_passages_no_delete"
  ON "contact_search_document_preview_passages" AS RESTRICTIVE
  FOR DELETE TO stella USING (false);--> statement-breakpoint

CREATE TABLE "workspace_search_document_preview_passages" (
  "workspace_id" uuid NOT NULL REFERENCES "workspace_search_documents"("workspace_id") ON DELETE CASCADE,
  "organization_id" varchar(128) NOT NULL,
  "generation" uuid NOT NULL,
  "ordinal" integer NOT NULL,
  "content" text NOT NULL,
  "tsv" tsvector NOT NULL,
  CONSTRAINT "workspace_search_document_preview_passages_pk"
    PRIMARY KEY ("workspace_id", "generation", "ordinal")
);--> statement-breakpoint
CREATE INDEX "workspace_preview_passages_scope_idx"
  ON "workspace_search_document_preview_passages"
  ("organization_id", "workspace_id", "generation", "ordinal");--> statement-breakpoint
CREATE INDEX "workspace_preview_passages_tsv_idx"
  ON "workspace_search_document_preview_passages" USING gin ("tsv");--> statement-breakpoint
ALTER TABLE "workspace_search_document_preview_passages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT ON TABLE "workspace_search_document_preview_passages" TO stella;--> statement-breakpoint
CREATE POLICY "workspace_search_document_preview_passages_workspace_select"
  ON "workspace_search_document_preview_passages" FOR SELECT TO stella
  USING (
    organization_id = (SELECT current_setting('app.organization_id', true))
    AND workspace_id = ANY(
      (SELECT current_setting('app.workspace_ids', true))::uuid[]
    )
  );--> statement-breakpoint
CREATE POLICY "workspace_search_document_preview_passages_no_insert"
  ON "workspace_search_document_preview_passages" AS RESTRICTIVE
  FOR INSERT TO stella WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "workspace_search_document_preview_passages_no_update"
  ON "workspace_search_document_preview_passages" AS RESTRICTIVE
  FOR UPDATE TO stella USING (false);--> statement-breakpoint
CREATE POLICY "workspace_search_document_preview_passages_no_delete"
  ON "workspace_search_document_preview_passages" AS RESTRICTIVE
  FOR DELETE TO stella USING (false);--> statement-breakpoint

CREATE TABLE "chat_thread_search_preview_passages" (
  "thread_id" uuid NOT NULL REFERENCES "chat_thread_search_documents"("thread_id") ON DELETE CASCADE,
  "generation" uuid NOT NULL,
  "ordinal" integer NOT NULL,
  "content" text NOT NULL,
  "tsv" tsvector NOT NULL,
  CONSTRAINT "chat_thread_search_preview_passages_pk"
    PRIMARY KEY ("thread_id", "generation", "ordinal")
);--> statement-breakpoint
CREATE INDEX "chat_thread_preview_passages_lookup_idx"
  ON "chat_thread_search_preview_passages"
  ("thread_id", "generation", "ordinal");--> statement-breakpoint
CREATE INDEX "chat_thread_preview_passages_tsv_idx"
  ON "chat_thread_search_preview_passages" USING gin ("tsv");--> statement-breakpoint
ALTER TABLE "chat_thread_search_preview_passages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT ON TABLE "chat_thread_search_preview_passages" TO stella;--> statement-breakpoint
CREATE POLICY "chat_thread_preview_passage_select"
  ON "chat_thread_search_preview_passages" FOR SELECT TO stella
  USING (EXISTS (
    SELECT 1 FROM chat_threads ct
    WHERE ct.id = chat_thread_search_preview_passages.thread_id
      AND ct.user_id = (SELECT current_setting('app.user_id', true))
      AND ct.organization_id =
        (SELECT current_setting('app.organization_id', true))
      AND (
        ct.workspace_id IS NULL
        OR ct.workspace_id = ANY(
          (SELECT current_setting('app.workspace_ids', true))::uuid[]
        )
      )
      AND (
        cardinality(ct.data_workspace_ids) = 0
        OR ct.data_workspace_ids <@
          (SELECT current_setting('app.workspace_ids', true))::uuid[]
      )
  ));--> statement-breakpoint
CREATE POLICY "chat_thread_preview_passage_no_insert"
  ON "chat_thread_search_preview_passages" AS RESTRICTIVE
  FOR INSERT TO stella WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "chat_thread_preview_passage_no_update"
  ON "chat_thread_search_preview_passages" AS RESTRICTIVE
  FOR UPDATE TO stella USING (false);--> statement-breakpoint
CREATE POLICY "chat_thread_preview_passage_no_delete"
  ON "chat_thread_search_preview_passages" AS RESTRICTIVE
  FOR DELETE TO stella USING (false);--> statement-breakpoint

CREATE TABLE "case_law_search_document_preview_passages" (
  "decision_id" uuid NOT NULL REFERENCES "case_law_search_documents"("decision_id") ON DELETE CASCADE,
  "generation" uuid NOT NULL,
  "ordinal" integer NOT NULL,
  "content" text NOT NULL,
  "tsv" tsvector NOT NULL,
  CONSTRAINT "case_law_search_document_preview_passages_pk"
    PRIMARY KEY ("decision_id", "generation", "ordinal")
);--> statement-breakpoint
CREATE INDEX "case_law_preview_passages_lookup_idx"
  ON "case_law_search_document_preview_passages"
  ("decision_id", "generation", "ordinal");--> statement-breakpoint
CREATE INDEX "case_law_preview_passages_tsv_idx"
  ON "case_law_search_document_preview_passages" USING gin ("tsv");--> statement-breakpoint
ALTER TABLE "case_law_search_document_preview_passages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT ON TABLE "case_law_search_document_preview_passages" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "case_law_search_document_preview_passages"
  TO stella_ingestion;--> statement-breakpoint
CREATE POLICY "case_law_global_access"
  ON "case_law_search_document_preview_passages"
  FOR SELECT TO stella USING (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access"
  ON "case_law_search_document_preview_passages"
  FOR ALL TO stella_ingestion USING (true) WITH CHECK (true);
