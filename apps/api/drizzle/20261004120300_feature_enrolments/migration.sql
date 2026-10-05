-- requires: 20261004120200_validate_uploaded_mail_correspondence
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
CREATE TABLE "feature_enrolments" (
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "organization_id" varchar(128) NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "feature_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "feature_enrolments_user_id_organization_id_feature_id_pk" PRIMARY KEY ("user_id", "organization_id", "feature_id"),
  CONSTRAINT "feature_enrolments_feature_id_check" CHECK (feature_id IN ('time-billing'))
);
--> statement-breakpoint
CREATE INDEX "feature_enrolments_organization_idx" ON "feature_enrolments" ("organization_id");
--> statement-breakpoint
ALTER TABLE "feature_enrolments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "feature_enrolments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "feature_enrolments" TO "stella";
--> statement-breakpoint
CREATE POLICY "feature_enrolments_owner" ON "feature_enrolments" FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.feature_enrolments'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.feature_enrolments'::regclass));
--> statement-breakpoint
CREATE POLICY "user_select" ON "feature_enrolments" FOR SELECT TO "stella" USING (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));
--> statement-breakpoint
CREATE POLICY "user_insert" ON "feature_enrolments" FOR INSERT TO "stella" WITH CHECK (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));
--> statement-breakpoint
CREATE POLICY "user_update" ON "feature_enrolments" FOR UPDATE TO "stella" USING (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true))) WITH CHECK (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));
--> statement-breakpoint
CREATE POLICY "user_delete" ON "feature_enrolments" FOR DELETE TO "stella" USING (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));
