-- requires: 20260429152450_entity-version-ai-summaries
-- requires: 20260510140000_document_rls_role_bootstrap
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "legal_reader_answers" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "user_id" text NOT NULL,
  "decision_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "visibility" text DEFAULT 'private' NOT NULL,
  "paragraph_id" varchar(64) NOT NULL,
  "quote" text NOT NULL,
  "start_offset" integer NOT NULL,
  "end_offset" integer NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "deleted_at" timestamptz,
  CONSTRAINT "legal_reader_answers_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE,
  CONSTRAINT "legal_reader_answers_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE,
  CONSTRAINT "legal_reader_answers_kind_values" CHECK ("kind" IN ('ask', 'explain')),
  CONSTRAINT "legal_reader_answers_visibility_values" CHECK ("visibility" IN ('private', 'shared')),
  CONSTRAINT "legal_reader_answers_span_shape" CHECK ("start_offset" >= 0 AND "end_offset" > "start_offset" AND "quote" <> '' AND "paragraph_id" <> '')
);--> statement-breakpoint
CREATE INDEX "legal_reader_answers_decision_idx" ON "legal_reader_answers" ("organization_id", "decision_id", "created_at", "id");--> statement-breakpoint
CREATE INDEX "legal_reader_answers_user_idx" ON "legal_reader_answers" ("user_id");--> statement-breakpoint

CREATE TABLE "legal_reader_answer_messages" (
  "id" uuid PRIMARY KEY NOT NULL,
  "answer_id" uuid NOT NULL,
  "role" text NOT NULL,
  "content" text NOT NULL,
  "citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "model" text,
  "usage" jsonb,
  "status" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "legal_reader_answer_messages_answer_fk" FOREIGN KEY ("answer_id") REFERENCES "legal_reader_answers"("id") ON DELETE CASCADE,
  CONSTRAINT "legal_reader_answer_messages_role_values" CHECK ("role" IN ('user', 'assistant')),
  CONSTRAINT "legal_reader_answer_messages_status_values" CHECK ("status" IN ('streaming', 'complete', 'failed')),
  CONSTRAINT "legal_reader_answer_messages_citations_array" CHECK (jsonb_typeof("citations") = 'array')
);--> statement-breakpoint
CREATE INDEX "legal_reader_answer_messages_answer_idx" ON "legal_reader_answer_messages" ("answer_id", "created_at", "id");--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "legal_reader_answers", "legal_reader_answer_messages" TO stella;--> statement-breakpoint
ALTER TABLE "legal_reader_answers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legal_reader_answers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legal_reader_answer_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legal_reader_answer_messages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Reader threads carry the same organization and author scope as annotations.
CREATE POLICY "organization_select" ON "legal_reader_answers" AS PERMISSIVE FOR SELECT TO stella
  USING (organization_id = (SELECT current_setting('app.organization_id', true))
    AND (visibility = 'shared' OR user_id = (SELECT current_setting('app.user_id', true))));--> statement-breakpoint
CREATE POLICY "author_insert" ON "legal_reader_answers" AS PERMISSIVE FOR INSERT TO stella
  WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true))
    AND user_id = (SELECT current_setting('app.user_id', true)));--> statement-breakpoint
CREATE POLICY "author_update" ON "legal_reader_answers" AS PERMISSIVE FOR UPDATE TO stella
  USING (organization_id = (SELECT current_setting('app.organization_id', true))
    AND user_id = (SELECT current_setting('app.user_id', true)));--> statement-breakpoint
CREATE POLICY "author_delete" ON "legal_reader_answers" AS PERMISSIVE FOR DELETE TO stella
  USING (organization_id = (SELECT current_setting('app.organization_id', true))
    AND user_id = (SELECT current_setting('app.user_id', true)));--> statement-breakpoint

-- The review reset clears every author's threads as the table owner; messages go by cascade.
CREATE POLICY "review_reset_owner_select" ON "legal_reader_answers" FOR SELECT TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.legal_reader_answers'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);--> statement-breakpoint
CREATE POLICY "review_reset_owner_delete" ON "legal_reader_answers" FOR DELETE TO PUBLIC USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.legal_reader_answers'::regclass)
  AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), '')
);--> statement-breakpoint

-- Parent RLS and explicit tenant/author checks govern the whole thread.
CREATE POLICY "answer_select" ON "legal_reader_answer_messages" AS PERMISSIVE FOR SELECT TO stella
  USING (EXISTS (SELECT 1 FROM legal_reader_answers answer
    WHERE answer.id = legal_reader_answer_messages.answer_id
      AND answer.organization_id = (SELECT current_setting('app.organization_id', true))
      AND (answer.visibility = 'shared' OR answer.user_id = (SELECT current_setting('app.user_id', true)))));--> statement-breakpoint
CREATE POLICY "answer_insert" ON "legal_reader_answer_messages" AS PERMISSIVE FOR INSERT TO stella
  WITH CHECK (EXISTS (SELECT 1 FROM legal_reader_answers answer
    WHERE answer.id = legal_reader_answer_messages.answer_id
      AND answer.organization_id = (SELECT current_setting('app.organization_id', true))
      AND answer.user_id = (SELECT current_setting('app.user_id', true))));--> statement-breakpoint
CREATE POLICY "answer_update" ON "legal_reader_answer_messages" AS PERMISSIVE FOR UPDATE TO stella
  USING (EXISTS (SELECT 1 FROM legal_reader_answers answer
    WHERE answer.id = legal_reader_answer_messages.answer_id
      AND answer.organization_id = (SELECT current_setting('app.organization_id', true))
      AND answer.user_id = (SELECT current_setting('app.user_id', true))))
  WITH CHECK (EXISTS (SELECT 1 FROM legal_reader_answers answer
    WHERE answer.id = legal_reader_answer_messages.answer_id
      AND answer.organization_id = (SELECT current_setting('app.organization_id', true))
      AND answer.user_id = (SELECT current_setting('app.user_id', true))));--> statement-breakpoint
CREATE POLICY "answer_delete" ON "legal_reader_answer_messages" AS PERMISSIVE FOR DELETE TO stella
  USING (EXISTS (SELECT 1 FROM legal_reader_answers answer
    WHERE answer.id = legal_reader_answer_messages.answer_id
      AND answer.organization_id = (SELECT current_setting('app.organization_id', true))
      AND answer.user_id = (SELECT current_setting('app.user_id', true))));
