SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint
-- The spelling fixes dictation learned from how a member corrects it, one
-- encrypted row per member and organization. Additive: a new table only.

CREATE TABLE "dictation_learned_fixes" (
  "organization_id" varchar(128) NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "generation" integer DEFAULT 0 NOT NULL,
  "revision" integer DEFAULT 0 NOT NULL,
  "ciphertext" bytea NOT NULL,
  "iv" bytea NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "dictation_learned_fixes_organization_id_user_id_pk" PRIMARY KEY ("organization_id", "user_id"),
  CONSTRAINT "dictation_learned_fixes_generation_check" CHECK ("dictation_learned_fixes"."generation" >= 0),
  CONSTRAINT "dictation_learned_fixes_revision_check" CHECK ("dictation_learned_fixes"."revision" >= 0)
);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "dictation_learned_fixes" TO stella;--> statement-breakpoint
ALTER TABLE "dictation_learned_fixes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dictation_learned_fixes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Each policy pins both the signed-in user and the active organization: the
-- fixes are their member's alone. UPDATE checks the resulting row too, so a
-- row cannot move to another user or organization.
CREATE POLICY "user_select" ON "dictation_learned_fixes" AS PERMISSIVE FOR SELECT TO stella
  USING (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "user_insert" ON "dictation_learned_fixes" AS PERMISSIVE FOR INSERT TO stella
  WITH CHECK (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "user_update" ON "dictation_learned_fixes" AS PERMISSIVE FOR UPDATE TO stella
  USING (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)))
  WITH CHECK (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "user_delete" ON "dictation_learned_fixes" AS PERMISSIVE FOR DELETE TO stella
  USING (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
-- Row security is forced, so the owning role (member removal, account
-- deletion, the review reset) is admitted by name; the app role never is.
CREATE POLICY "dictation_learned_fixes_owner" ON "dictation_learned_fixes" FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.dictation_learned_fixes'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.dictation_learned_fixes'::regclass));
