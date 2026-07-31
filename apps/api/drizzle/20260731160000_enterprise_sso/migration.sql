-- Additive enterprise SSO groundwork. Better Auth owns protocol callbacks;
-- Stella owns provider management, audit, domain verification and enforcement.
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "authentication_method" text DEFAULT 'non_sso' NOT NULL;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "sso_provider_id" text;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_sso_provenance_check" CHECK (("authentication_method" = 'sso' AND "sso_provider_id" IS NOT NULL) OR ("authentication_method" = 'non_sso' AND "sso_provider_id" IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "session" VALIDATE CONSTRAINT "session_sso_provenance_check";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "session_sso_provider_id_idx" ON "session" ("sso_provider_id");--> statement-breakpoint
CREATE TABLE "sso_provider" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"domain" text NOT NULL,
	"oidc_config" text,
	"saml_config" text,
	"user_id" text,
	"provider_id" text NOT NULL,
	"protocol" text NOT NULL,
	"organization_id" text NOT NULL,
	"domain_verified" boolean DEFAULT false NOT NULL,
	"enforcement_mode" text DEFAULT 'optional' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_provider_protocol_config_check" CHECK (("protocol" = 'oidc' AND "oidc_config" IS NOT NULL AND "saml_config" IS NULL) OR ("protocol" = 'saml' AND "oidc_config" IS NULL AND "saml_config" IS NOT NULL)),
	CONSTRAINT "sso_provider_enforcement_mode_check" CHECK ("enforcement_mode" IN ('optional', 'required')),
	CONSTRAINT "sso_provider_protocol_check" CHECK ("protocol" IN ('oidc', 'saml'))
);--> statement-breakpoint
ALTER TABLE "sso_provider" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sso_provider" ADD CONSTRAINT "sso_provider_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "sso_provider" ADD CONSTRAINT "sso_provider_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE UNIQUE INDEX "sso_provider_provider_id_uidx" ON "sso_provider" ("provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sso_provider_organization_id_uidx" ON "sso_provider" ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sso_provider_domain_uidx" ON "sso_provider" ("domain");--> statement-breakpoint
CREATE POLICY "sso_provider_no_select" ON "sso_provider" AS RESTRICTIVE FOR SELECT TO "stella" USING (false);--> statement-breakpoint
CREATE POLICY "sso_provider_no_insert" ON "sso_provider" AS RESTRICTIVE FOR INSERT TO "stella" WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "sso_provider_no_update" ON "sso_provider" AS RESTRICTIVE FOR UPDATE TO "stella" USING (false);--> statement-breakpoint
CREATE POLICY "sso_provider_no_delete" ON "sso_provider" AS RESTRICTIVE FOR DELETE TO "stella" USING (false);
