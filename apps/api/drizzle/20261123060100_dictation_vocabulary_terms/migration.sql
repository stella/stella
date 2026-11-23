SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint
-- The organization's dictation words. Additive: one new, empty
-- organization-scoped table with its indexes and policies.
CREATE TABLE "dictation_vocabulary_terms" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "term" varchar(100) NOT NULL,
  "term_key" text NOT NULL,
  "created_by" text REFERENCES "user"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "dictation_vocabulary_terms_term_check" CHECK (length(btrim("term")) > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX "dictation_vocabulary_terms_org_key_idx" ON "dictation_vocabulary_terms" ("organization_id","term_key");--> statement-breakpoint
CREATE INDEX "dictation_vocabulary_terms_org_created_idx" ON "dictation_vocabulary_terms" ("organization_id","created_at" DESC,"id" DESC);--> statement-breakpoint
ALTER TABLE "dictation_vocabulary_terms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dictation_vocabulary_terms" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "dictation_vocabulary_terms" TO stella;--> statement-breakpoint
CREATE POLICY "organization_select" ON "dictation_vocabulary_terms" FOR SELECT TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_insert" ON "dictation_vocabulary_terms" FOR INSERT TO stella WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_update" ON "dictation_vocabulary_terms" FOR UPDATE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "organization_delete" ON "dictation_vocabulary_terms" FOR DELETE TO stella USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "dictation_vocabulary_terms_owner_access" ON "dictation_vocabulary_terms" AS PERMISSIVE FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.dictation_vocabulary_terms'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.dictation_vocabulary_terms'::regclass));
