SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN "registration_origin" text NOT NULL DEFAULT 'managed';--> statement-breakpoint
ALTER TABLE "oauth_client" ADD CONSTRAINT "oauth_client_registration_origin_check" CHECK ("registration_origin" IN ('managed', 'open-client', 'agent')) NOT VALID;--> statement-breakpoint
CREATE TABLE "registration_daily_budget" (
  "day" timestamptz NOT NULL,
  "kind" text NOT NULL,
  "count" integer NOT NULL,
  PRIMARY KEY ("day", "kind"),
  CONSTRAINT "registration_daily_budget_kind_check" CHECK ("kind" IN ('agent', 'open-client')),
  CONSTRAINT "registration_daily_budget_count_check" CHECK ("count" > 0)
);--> statement-breakpoint
ALTER TABLE "registration_daily_budget" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "registration_daily_budget" AS PERMISSIVE FOR ALL TO "stella" USING (false) WITH CHECK (false);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "registration_daily_budget" FROM stella;--> statement-breakpoint
INSERT INTO "scheduler_jobs" ("id", "task", "description", "schedule", "enabled", "next_run_at")
VALUES ('auth.sweepRegistrations.hour', 'auth.sweepRegistrations', 'Delete expired unused registrations', '{"type":"interval","everyMs":3600000}', true, now())
ON CONFLICT ON CONSTRAINT "scheduler_jobs_pkey" DO NOTHING;--> statement-breakpoint
