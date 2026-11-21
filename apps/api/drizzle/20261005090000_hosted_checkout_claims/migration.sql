-- requires: 20261003123500_configured_access
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
CREATE TABLE "hosted_checkout_claims" (
  "organization_id" varchar(128) PRIMARY KEY NOT NULL CONSTRAINT "hosted_checkout_claims_organization_id_organization_id_fk" REFERENCES "organization"("id") ON DELETE cascade,
  "claim_id" uuid NOT NULL,
  "hosted_session_id" text,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "hosted_checkout_claims" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hosted_checkout_claims" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "hosted_checkout_claims" TO "stella";
--> statement-breakpoint
CREATE POLICY "hosted_checkout_claims_owner" ON "hosted_checkout_claims" FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.hosted_checkout_claims'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.hosted_checkout_claims'::regclass));
--> statement-breakpoint
CREATE POLICY "hosted_checkout_claims_organization_select" ON "hosted_checkout_claims" FOR SELECT TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)));
--> statement-breakpoint
CREATE POLICY "hosted_checkout_claims_organization_insert" ON "hosted_checkout_claims" FOR INSERT TO "stella" WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));
--> statement-breakpoint
CREATE POLICY "hosted_checkout_claims_organization_update" ON "hosted_checkout_claims" FOR UPDATE TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true))) WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));
--> statement-breakpoint
CREATE POLICY "hosted_checkout_claims_organization_delete" ON "hosted_checkout_claims" FOR DELETE TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)));
