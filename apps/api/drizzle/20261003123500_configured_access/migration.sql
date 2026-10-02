-- requires: 20261003123400_validate_hosted_closed_period
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "usage_policies" ADD COLUMN "service_actions_per_period" integer;
--> statement-breakpoint
ALTER TABLE "usage_policies" ADD CONSTRAINT "usage_policies_service_actions_positive"
CHECK (service_actions_per_period IS NULL OR service_actions_per_period > 0) NOT VALID;
--> statement-breakpoint
CREATE TABLE "organization_configured_access" (
  "organization_id" varchar(128) PRIMARY KEY NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "source_signature" text NOT NULL,
  "source_event_at" timestamptz,
  "source_entitlement_status" text NOT NULL,
  "source_cancel_at_period_end" boolean NOT NULL,
  "configured_access_status" text NOT NULL,
  "configured_period_ends_at" timestamptz,
  "payment_retry_ends_at" timestamptz,
  "service_actions_per_period" integer,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "organization_configured_access" ADD CONSTRAINT "organization_configured_access_source_status" CHECK (source_entitlement_status IN ('trialing', 'active', 'past_due', 'cancelled', 'paused')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "organization_configured_access" ADD CONSTRAINT "organization_configured_access_shape" CHECK (((configured_access_status IN ('active', 'ending') AND configured_period_ends_at IS NOT NULL AND payment_retry_ends_at IS NULL AND service_actions_per_period > 0) OR (configured_access_status = 'payment_retry' AND configured_period_ends_at IS NOT NULL AND payment_retry_ends_at IS NOT NULL AND service_actions_per_period > 0) OR (configured_access_status = 'disabled' AND configured_period_ends_at IS NULL AND payment_retry_ends_at IS NULL AND service_actions_per_period IS NULL)) IS TRUE) NOT VALID;
--> statement-breakpoint
ALTER TABLE "organization_configured_access" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "organization_configured_access" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "organization_configured_access" TO "stella";
--> statement-breakpoint
CREATE POLICY "organization_configured_access_owner" ON "organization_configured_access" FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.organization_configured_access'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.organization_configured_access'::regclass));
--> statement-breakpoint
CREATE POLICY "organization_configured_access_organization_select" ON "organization_configured_access" FOR SELECT TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)));
--> statement-breakpoint
CREATE POLICY "organization_configured_access_no_insert" ON "organization_configured_access" AS RESTRICTIVE FOR INSERT TO "stella" WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY "organization_configured_access_no_update" ON "organization_configured_access" AS RESTRICTIVE FOR UPDATE TO "stella" USING (false);
--> statement-breakpoint
CREATE POLICY "organization_configured_access_no_delete" ON "organization_configured_access" AS RESTRICTIVE FOR DELETE TO "stella" USING (false);
