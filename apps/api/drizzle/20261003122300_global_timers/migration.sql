SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint
CREATE TABLE "time_timers" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE set null,
  "description" text,
  "legacy_time_entry_id" uuid REFERENCES "time_entries"("id") ON DELETE set null,
  "state" text NOT NULL,
  "started_at" timestamptz NOT NULL,
  "accumulated_seconds" integer DEFAULT 0 NOT NULL,
  "last_resumed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "time_timers_workspace_organization_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "workspaces"("id", "organization_id"),
  CONSTRAINT "time_timers_state_check" CHECK ("state" IN ('running', 'paused')),
  CONSTRAINT "time_timers_accumulated_seconds_check" CHECK ("accumulated_seconds" >= 0),
  CONSTRAINT "time_timers_resume_state_check" CHECK (("state" = 'running') = ("last_resumed_at" IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX "time_timers_one_running_owner_idx" ON "time_timers" ("organization_id", "user_id") WHERE "state" = 'running';--> statement-breakpoint
CREATE INDEX "time_timers_owner_id_idx" ON "time_timers" ("organization_id", "user_id", "id");--> statement-breakpoint
CREATE INDEX "time_timers_workspace_idx" ON "time_timers" ("workspace_id");--> statement-breakpoint
CREATE INDEX "time_timers_legacy_entry_idx" ON "time_timers" ("legacy_time_entry_id");--> statement-breakpoint

-- Preserve the running clock and original draft until confirmation or discard.
-- stella-migration-safety: reviewed bulk-backfill - copies only active draft timers, bounded by the existing one-active-timer-per-user index; the original entries remain intact for rollback.
INSERT INTO "time_timers" ("id", "organization_id", "user_id", "workspace_id", "description", "legacy_time_entry_id", "state", "started_at", "accumulated_seconds", "last_resumed_at", "created_at", "updated_at")
SELECT "id", "organization_id", "user_id", "workspace_id", "narrative", "id", 'running', "timer_started_at", 0, "timer_started_at", "created_at", now()
FROM "time_entries"
WHERE "timer_started_at" IS NOT NULL AND "timer_stopped_at" IS NULL AND "status" = 'draft' AND "source" = 'timer' AND "user_id" IS NOT NULL;--> statement-breakpoint

CREATE TABLE "time_timer_confirmations" (
  "timer_id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "time_entry_id" uuid REFERENCES "time_entries"("id") ON DELETE set null,
  "created_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "time_timer_confirmations_owner_idx" ON "time_timer_confirmations" ("organization_id", "user_id");--> statement-breakpoint
CREATE INDEX "time_timer_confirmations_entry_idx" ON "time_timer_confirmations" ("time_entry_id");--> statement-breakpoint
ALTER TABLE "time_timers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "time_timers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "time_timers" TO stella;--> statement-breakpoint
CREATE POLICY "user_select" ON "time_timers" AS PERMISSIVE FOR SELECT TO stella USING (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "user_insert" ON "time_timers" AS PERMISSIVE FOR INSERT TO stella WITH CHECK (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "user_update" ON "time_timers" AS PERMISSIVE FOR UPDATE TO stella USING (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true))) WITH CHECK (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "user_delete" ON "time_timers" AS PERMISSIVE FOR DELETE TO stella USING (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "current_member" ON "time_timers" AS RESTRICTIVE FOR ALL TO stella
  USING (EXISTS (SELECT 1 FROM "member" WHERE "member"."organization_id" = "time_timers"."organization_id" AND "member"."user_id" = "time_timers"."user_id"))
  WITH CHECK (EXISTS (SELECT 1 FROM "member" WHERE "member"."organization_id" = "time_timers"."organization_id" AND "member"."user_id" = "time_timers"."user_id"));--> statement-breakpoint
ALTER TABLE "time_timer_confirmations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "time_timer_confirmations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "time_timer_confirmations" TO stella;--> statement-breakpoint
CREATE POLICY "user_select" ON "time_timer_confirmations" AS PERMISSIVE FOR SELECT TO stella USING (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "user_insert" ON "time_timer_confirmations" AS PERMISSIVE FOR INSERT TO stella WITH CHECK (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "user_update" ON "time_timer_confirmations" AS PERMISSIVE FOR UPDATE TO stella USING (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true))) WITH CHECK (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "user_delete" ON "time_timer_confirmations" AS PERMISSIVE FOR DELETE TO stella USING (user_id = (SELECT current_setting('app.user_id', true)) AND organization_id = (SELECT current_setting('app.organization_id', true)));--> statement-breakpoint
