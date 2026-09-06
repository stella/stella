SET lock_timeout = '5s';
--> statement-breakpoint
SET statement_timeout = '30s';
--> statement-breakpoint
CREATE TABLE "business_registry_credentials" (
  "organization_id" varchar(128) NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "registry" text NOT NULL,
  "ciphertext" bytea NOT NULL,
  "iv" bytea NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY ("organization_id", "registry"),
  CONSTRAINT "business_registry_credentials_registry_check" CHECK ("registry" IN ('companies-house', 'denue', 'edgar'))
);
--> statement-breakpoint
ALTER TABLE "business_registry_credentials" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "organization_select" ON "business_registry_credentials" FOR SELECT TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)));
--> statement-breakpoint
CREATE POLICY "organization_insert" ON "business_registry_credentials" FOR INSERT TO "stella" WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));
--> statement-breakpoint
CREATE POLICY "organization_update" ON "business_registry_credentials" FOR UPDATE TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)));
--> statement-breakpoint
CREATE POLICY "organization_delete" ON "business_registry_credentials" FOR DELETE TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)));
