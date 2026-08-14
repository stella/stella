SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Which budget a usage event settles against. Every pre-existing row
-- settled the org pool, which the default expresses without a backfill.
ALTER TABLE "usage_events"
  ADD COLUMN IF NOT EXISTS "lane" text DEFAULT 'pool' NOT NULL;--> statement-breakpoint

-- Validating immediately: the events table is young and the check is a
-- constant-domain test, so NOT VALID + VALIDATE buys nothing.
ALTER TABLE "usage_events"
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "usage_events_lane_domain"
  CHECK (lane IN ('pool', 'allowance', 'fallback'));--> statement-breakpoint

-- Per-seat budget sizes, operator-seeded like the price fields.
ALTER TABLE "usage_policies"
  ADD COLUMN IF NOT EXISTS "daily_allowance_micro_units" integer,
  ADD COLUMN IF NOT EXISTS "fallback_weekly_micro_units" integer;--> statement-breakpoint

-- Bounded operator catalog; immediate validation for the same reason.
ALTER TABLE "usage_policies"
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "usage_policies_daily_allowance_nonneg"
  CHECK (daily_allowance_micro_units IS NULL OR daily_allowance_micro_units >= 0),
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "usage_policies_fallback_weekly_nonneg"
  CHECK (fallback_weekly_micro_units IS NULL OR fallback_weekly_micro_units >= 0);--> statement-breakpoint

-- Per-user budget accumulators: one row per (org, user, kind, bucket),
-- upserted in the same transaction as the usage event they settle and
-- read as a point lookup at pre-flight. Buckets are UTC-aligned; a new
-- bucket row starting at zero is the reset.
CREATE TABLE IF NOT EXISTS "usage_lane_counters" (
  "id" uuid PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "bucket_start" timestamptz NOT NULL,
  "micro_units" bigint DEFAULT 0 NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "usage_lane_counters_micro_units_nonneg" CHECK (micro_units >= 0),
  CONSTRAINT "usage_lane_counters_kind_domain" CHECK (kind IN ('daily', 'fallback_weekly'))
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "usage_lane_counters_org_user_kind_bucket_uidx"
  ON "usage_lane_counters" ("organization_id", "user_id", "kind", "bucket_start");--> statement-breakpoint

ALTER TABLE "usage_lane_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "usage_lane_counters_select" ON "usage_lane_counters" AS PERMISSIVE FOR SELECT TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint

CREATE POLICY "usage_lane_counters_insert" ON "usage_lane_counters" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint

CREATE POLICY "usage_lane_counters_update" ON "usage_lane_counters" AS PERMISSIVE FOR UPDATE TO "stella" USING (organization_id = (SELECT current_setting('app.organization_id', true))) WITH CHECK (organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint

CREATE POLICY "usage_lane_counters_no_delete" ON "usage_lane_counters" AS RESTRICTIVE FOR DELETE TO "stella" USING (false);
