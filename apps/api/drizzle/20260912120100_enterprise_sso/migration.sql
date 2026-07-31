-- Additive enterprise SSO groundwork. Better Auth owns protocol callbacks;
-- Stella owns provider management, audit, domain verification and enforcement.
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint
-- Every statement before the transaction split must be replay-safe: a failed
-- concurrent index build leaves this migration unrecorded while these changes
-- remain committed.
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "authentication_method" text DEFAULT 'non_sso' NOT NULL;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "sso_provider_id" text;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - this drops only the check below by its unique name and immediately recreates it with the same definition, making a replay after an interrupted concurrent index build safe without touching row data.
ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_sso_provenance_check", ADD CONSTRAINT "session_sso_provenance_check" CHECK (("authentication_method" = 'sso' AND "sso_provider_id" IS NOT NULL) OR ("authentication_method" = 'non_sso' AND "sso_provider_id" IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "session" VALIDATE CONSTRAINT "session_sso_provenance_check";--> statement-breakpoint

-- Drizzle starts migrations in a transaction, while PostgreSQL requires a
-- concurrent index build outside one. Lift the timeouts during the build,
-- then restore them and reopen a transaction for the remaining DDL and the
-- migration journal row.
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "session_sso_provider_id_idx";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "session_sso_provider_id_idx" ON "session" ("sso_provider_id");--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;--> statement-breakpoint
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
