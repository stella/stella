-- requires: 20261005120500_feature_enrolments
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
CREATE TABLE "user_professional_use_acceptances" (
  "user_id" text PRIMARY KEY NOT NULL CONSTRAINT "user_professional_use_acceptances_user_id_user_id_fk" REFERENCES "user"("id") ON DELETE cascade,
  "statement_version" text NOT NULL,
  "terms_version" text NOT NULL,
  "accepted_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
ALTER TABLE "user_professional_use_acceptances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_professional_use_acceptances" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "user_professional_use_acceptances" FROM stella;--> statement-breakpoint
CREATE POLICY "user_professional_use_acceptances_owner_access" ON "user_professional_use_acceptances" FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.user_professional_use_acceptances'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.user_professional_use_acceptances'::regclass));--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "user_professional_use_acceptances" FOR ALL TO stella USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE TABLE "organization_professional_use_acceptances" (
  "organization_id" varchar(128) PRIMARY KEY NOT NULL CONSTRAINT "organization_professional_use_acceptances_organization_fk" REFERENCES "organization"("id") ON DELETE cascade,
  "accepted_by_user_id" text CONSTRAINT "organization_professional_use_acceptances_user_fk" REFERENCES "user"("id") ON DELETE set null,
  "statement_version" text NOT NULL,
  "terms_version" text NOT NULL,
  "accepted_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX "organization_professional_use_acceptances_user_idx" ON "organization_professional_use_acceptances" ("accepted_by_user_id");--> statement-breakpoint
ALTER TABLE "organization_professional_use_acceptances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_professional_use_acceptances" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "organization_professional_use_acceptances" FROM stella;--> statement-breakpoint
CREATE POLICY "organization_professional_use_acceptances_owner_access" ON "organization_professional_use_acceptances" FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.organization_professional_use_acceptances'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.organization_professional_use_acceptances'::regclass));--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "organization_professional_use_acceptances" FOR ALL TO stella USING (false) WITH CHECK (false);
