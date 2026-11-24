SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Optional admin-chosen display label for an SSO provider (e.g. "Okta").
-- Nullable without a default so existing rows are not rewritten.
ALTER TABLE "sso_provider" ADD COLUMN "display_name" text;--> statement-breakpoint

-- Verified email domains owned by an organization for SSO sign-in discovery
-- and domain-scoped identity rules. Kept separate from `sso_provider` so
-- rotating or replacing a provider does not require re-verifying DNS.
CREATE TABLE "organization_sso_domain" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "domain" text NOT NULL,
  "verification_token" text NOT NULL,
  "verified_at" timestamp with time zone,
  "last_checked_at" timestamp with time zone,
  "created_by" text REFERENCES "user"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "organization_sso_domain_domain_check" CHECK (
    "domain" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
  )
);--> statement-breakpoint
CREATE UNIQUE INDEX "organization_sso_domain_org_domain_uidx"
  ON "organization_sso_domain" ("organization_id", "domain");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_sso_domain_verified_uidx"
  ON "organization_sso_domain" ("domain")
  WHERE "verified_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "organization_sso_domain_organization_id_idx"
  ON "organization_sso_domain" ("organization_id");--> statement-breakpoint
CREATE INDEX "organization_sso_domain_created_by_idx"
  ON "organization_sso_domain" ("created_by");--> statement-breakpoint

ALTER TABLE "organization_sso_domain" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_sso_domain" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "organization_sso_domain_owner_access" ON "organization_sso_domain" FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.organization_sso_domain'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.organization_sso_domain'::regclass));--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "organization_sso_domain"
  AS PERMISSIVE FOR ALL TO "stella"
  USING (false) WITH CHECK (false);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "organization_sso_domain" FROM stella;
