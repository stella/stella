SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Organization single sign-on (OIDC), additive. The session column is
-- nullable without a default, so adding it rewrites no row; every existing
-- session reads as one no SSO provider created.
ALTER TABLE "session" ADD COLUMN "sso_provider_id" text;--> statement-breakpoint
-- The provider row that created an SSO identity; null for every account that
-- exists today, none of which an SSO provider created.
ALTER TABLE "account" ADD COLUMN "sso_provider_id" text;--> statement-breakpoint

CREATE TABLE "sso_provider" (
  "id" text PRIMARY KEY NOT NULL,
  "provider_id" text NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "issuer" text NOT NULL,
  "domain" text NOT NULL,
  "oidc_config" text,
  "saml_config" text,
  "user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sso_provider_provider_id_check" CHECK ("provider_id" ~ '^sso_[a-z0-9][a-z0-9_-]{0,62}$'),
  CONSTRAINT "sso_provider_oidc_only_check" CHECK ("oidc_config" IS NOT NULL AND "saml_config" IS NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX "sso_provider_provider_id_uidx" ON "sso_provider" ("provider_id");--> statement-breakpoint
CREATE INDEX "sso_provider_organization_id_idx" ON "sso_provider" ("organization_id");--> statement-breakpoint
CREATE INDEX "sso_provider_user_id_idx" ON "sso_provider" ("user_id");--> statement-breakpoint

-- A provider row is one provider generation: sessions and identities bind to
-- its id, so its id, provider id, issuer and organization never change.
-- Replacing a provider means a new row.
CREATE FUNCTION "guard_sso_provider_identity"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."provider_id" IS DISTINCT FROM OLD."provider_id"
     OR NEW."issuer" IS DISTINCT FROM OLD."issuer"
     OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id" THEN
    RAISE EXCEPTION 'sso provider identity is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "sso_provider_identity_guard"
  BEFORE UPDATE ON "sso_provider"
  FOR EACH ROW EXECUTE FUNCTION "guard_sso_provider_identity"();--> statement-breakpoint

CREATE TABLE "organization_sso_policy" (
  "organization_id" text PRIMARY KEY NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "requirement" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "organization_sso_policy_requirement_check" CHECK ("requirement" IN ('optional', 'required'))
);--> statement-breakpoint

-- Only the owner connection the auth layer uses reaches either table; the
-- request role reads no provider configuration and no policy. The provider
-- table is a Better Auth model and follows the other auth tables; the policy
-- table is this app's own and forces row security with an owner-only policy.
ALTER TABLE "sso_provider" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_sso_policy" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_sso_policy" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "organization_sso_policy_owner_access" ON "organization_sso_policy" FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.organization_sso_policy'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.organization_sso_policy'::regclass));--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "sso_provider"
  AS PERMISSIVE FOR ALL TO "stella"
  USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "organization_sso_policy"
  AS PERMISSIVE FOR ALL TO "stella"
  USING (false) WITH CHECK (false);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "sso_provider" FROM stella;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "organization_sso_policy" FROM stella;
