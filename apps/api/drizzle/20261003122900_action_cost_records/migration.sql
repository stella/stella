SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "action_cost_records" (
  "organization_id" text NOT NULL,
  "action_kind" text NOT NULL,
  "logical_phase_id" text NOT NULL,
  "user_id" text,
  "admitted_at" timestamptz NOT NULL,
  "settled_at" timestamptz,
  "estimated_micro_units" bigint,
  CONSTRAINT "action_cost_records_pkey" PRIMARY KEY ("organization_id", "action_kind", "logical_phase_id"),
  CONSTRAINT "action_cost_records_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE,
  CONSTRAINT "action_cost_records_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL,
  CONSTRAINT "action_cost_records_estimate_nonneg" CHECK (estimated_micro_units IS NULL OR estimated_micro_units >= 0),
  CONSTRAINT "action_cost_records_time_order" CHECK (settled_at IS NULL OR settled_at >= admitted_at)
);--> statement-breakpoint
CREATE INDEX "action_cost_records_org_period_kind_idx" ON "action_cost_records" ("organization_id", "admitted_at", "action_kind");--> statement-breakpoint
CREATE INDEX "action_cost_records_retention_idx" ON "action_cost_records" ("admitted_at");--> statement-breakpoint
ALTER TABLE "action_cost_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "action_cost_records" FOR ALL TO stella USING (false) WITH CHECK (false);--> statement-breakpoint

CREATE TABLE "action_cost_calls" (
  "organization_id" text NOT NULL,
  "action_kind" text NOT NULL,
  "logical_phase_id" text NOT NULL,
  "call_id" text NOT NULL,
  "kind" text NOT NULL,
  "occurred_at" timestamptz NOT NULL,
  "measured_micro_units" bigint,
  CONSTRAINT "action_cost_calls_pkey" PRIMARY KEY ("organization_id", "action_kind", "logical_phase_id", "call_id"),
  CONSTRAINT "action_cost_calls_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE,
  CONSTRAINT "action_cost_calls_measured_nonneg" CHECK (measured_micro_units IS NULL OR measured_micro_units >= 0)
);--> statement-breakpoint
CREATE INDEX "action_cost_calls_org_period_kind_idx" ON "action_cost_calls" ("organization_id", "occurred_at", "action_kind");--> statement-breakpoint
CREATE INDEX "action_cost_calls_retention_idx" ON "action_cost_calls" ("occurred_at");--> statement-breakpoint
ALTER TABLE "action_cost_calls" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "action_cost_calls" FOR ALL TO stella USING (false) WITH CHECK (false);--> statement-breakpoint

ALTER TABLE "usage_events" ADD COLUMN "action_kind" text;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "logical_phase_id" text;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_action_identity_pair" CHECK ((action_kind IS NULL) = (logical_phase_id IS NULL)) NOT VALID;--> statement-breakpoint
