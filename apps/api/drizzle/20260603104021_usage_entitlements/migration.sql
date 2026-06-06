-- Usage entitlements + usage ledger tables.
-- Hand-rolled (drizzle-kit generate requires TTY in this harness).
-- Re-running `bun --bun drizzle-kit generate --name=usage_entitlements`
-- from apps/api/ will produce an equivalent file with snapshot.json
-- when next a developer is in an interactive shell.

CREATE TABLE "usage_policies" (
	"id" uuid PRIMARY KEY,
	"policy_key" varchar(64) NOT NULL,
	"display_name" varchar(128) NOT NULL,
	"monthly_usage_units" integer NOT NULL,
	"hosted_policy_ref" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "usage_policies_policy_key_format" CHECK (policy_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
	CONSTRAINT "usage_policies_monthly_usage_units_nonneg" CHECK (monthly_usage_units >= 0)
);
--> statement-breakpoint
ALTER TABLE "usage_policies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX "usage_policies_key_active_idx" ON "usage_policies" ("policy_key","active");
--> statement-breakpoint
CREATE UNIQUE INDEX "usage_policies_policy_key_uidx" ON "usage_policies" ("policy_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "usage_policies_hosted_policy_ref_uidx" ON "usage_policies" ("hosted_policy_ref") WHERE hosted_policy_ref IS NOT NULL;
--> statement-breakpoint
CREATE POLICY "usage_policies_select" ON "usage_policies" AS PERMISSIVE FOR SELECT TO "stella" USING (true);

--> statement-breakpoint
CREATE TABLE "usage_entitlements" (
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"usage_policy_id" uuid NOT NULL,
	"status" text NOT NULL,
	"seats" integer NOT NULL,
	"current_period_start" timestamp with time zone NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"hosted_account_ref" text,
	"hosted_entitlement_external_id" text,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "usage_entitlements_seats_positive" CHECK (seats > 0),
	CONSTRAINT "usage_entitlements_period_order" CHECK (current_period_end > current_period_start)
);
--> statement-breakpoint
ALTER TABLE "usage_entitlements" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE UNIQUE INDEX "usage_entitlements_organization_id_uidx" ON "usage_entitlements" ("organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "usage_entitlements_hosted_entitlement_external_id_uidx" ON "usage_entitlements" ("hosted_entitlement_external_id") WHERE hosted_entitlement_external_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "usage_entitlements_hosted_account_ref_uidx" ON "usage_entitlements" ("hosted_account_ref") WHERE hosted_account_ref IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "usage_entitlements" ADD CONSTRAINT "usage_entitlements_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "usage_entitlements" ADD CONSTRAINT "usage_entitlements_usage_policy_id_usage_policies_id_fkey" FOREIGN KEY ("usage_policy_id") REFERENCES "usage_policies"("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE POLICY "usage_entitlements_select" ON "usage_entitlements" AS PERMISSIVE FOR SELECT TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)));
--> statement-breakpoint
CREATE POLICY "usage_entitlements_no_insert" ON "usage_entitlements" AS RESTRICTIVE FOR INSERT TO "stella" WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY "usage_entitlements_no_update" ON "usage_entitlements" AS RESTRICTIVE FOR UPDATE TO "stella" USING (false);
--> statement-breakpoint
CREATE POLICY "usage_entitlements_no_delete" ON "usage_entitlements" AS RESTRICTIVE FOR DELETE TO "stella" USING (false);

--> statement-breakpoint
CREATE TABLE "usage_allocations" (
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"units" integer NOT NULL,
	"reason" text NOT NULL,
	"source_type" text NOT NULL,
	"source_ref" text,
	"seat_scope_user_id" text,
	"allocated_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "usage_allocations_units_positive" CHECK (units > 0),
	CONSTRAINT "usage_allocations_period_order" CHECK (period_end > period_start)
);
--> statement-breakpoint
ALTER TABLE "usage_allocations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX "usage_allocations_org_period_idx" ON "usage_allocations" ("organization_id","period_start");
--> statement-breakpoint
CREATE UNIQUE INDEX "usage_allocations_org_source_ref_uidx" ON "usage_allocations" ("organization_id","source_type","source_ref") WHERE source_ref IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "usage_allocations" ADD CONSTRAINT "usage_allocations_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "usage_allocations" ADD CONSTRAINT "usage_allocations_allocated_by_user_id_user_id_fkey" FOREIGN KEY ("allocated_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE POLICY "usage_allocations_select" ON "usage_allocations" AS PERMISSIVE FOR SELECT TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)));
--> statement-breakpoint
CREATE POLICY "usage_allocations_no_insert" ON "usage_allocations" AS RESTRICTIVE FOR INSERT TO "stella" WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY "usage_allocations_no_update" ON "usage_allocations" AS RESTRICTIVE FOR UPDATE TO "stella" USING (false);
--> statement-breakpoint
CREATE POLICY "usage_allocations_no_delete" ON "usage_allocations" AS RESTRICTIVE FOR DELETE TO "stella" USING (false);

--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"workspace_id" uuid,
	"user_id" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"action_type" text NOT NULL,
	"model_role" varchar(32) NOT NULL,
	"units_consumed" integer NOT NULL,
	"raw_usage_micro_units" bigint,
	"service_tier" text NOT NULL,
	"is_byok" boolean DEFAULT false NOT NULL,
	"trace_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "usage_events_units_nonneg" CHECK (units_consumed >= 0),
	CONSTRAINT "usage_events_period_order" CHECK (period_end > period_start)
);
--> statement-breakpoint
ALTER TABLE "usage_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX "usage_events_org_period_idx" ON "usage_events" ("organization_id","period_start");
--> statement-breakpoint
CREATE INDEX "usage_events_org_user_period_idx" ON "usage_events" ("organization_id","user_id","period_start");
--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE POLICY "usage_events_select" ON "usage_events" AS PERMISSIVE FOR SELECT TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)));
--> statement-breakpoint
CREATE POLICY "usage_events_insert" ON "usage_events" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));
--> statement-breakpoint
CREATE POLICY "usage_events_no_update" ON "usage_events" AS RESTRICTIVE FOR UPDATE TO "stella" USING (false);
--> statement-breakpoint
CREATE POLICY "usage_events_no_delete" ON "usage_events" AS RESTRICTIVE FOR DELETE TO "stella" USING (false);

--> statement-breakpoint
CREATE TABLE "usage_provider_webhook_events" (
	"event_id" text PRIMARY KEY,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"result" text NOT NULL,
	"error_message" text
);
--> statement-breakpoint
ALTER TABLE "usage_provider_webhook_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX "usage_provider_webhook_events_processed_at_idx" ON "usage_provider_webhook_events" ("processed_at");
--> statement-breakpoint
CREATE POLICY "usage_provider_webhook_events_no_stella_access" ON "usage_provider_webhook_events" AS PERMISSIVE FOR ALL TO "stella" USING (false) WITH CHECK (false);

--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
	"usage_policies",
	"usage_entitlements",
	"usage_allocations",
	"usage_events",
	"usage_provider_webhook_events"
TO stella;
