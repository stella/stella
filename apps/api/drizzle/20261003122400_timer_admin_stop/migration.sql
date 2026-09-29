-- requires: 20261003122300_global_timers
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint
CREATE POLICY "organization_admin_select" ON "time_timers" AS PERMISSIVE FOR SELECT TO stella
  USING ("time_timers"."organization_id" = (SELECT current_setting('app.organization_id', true))
    AND EXISTS (
      SELECT 1 FROM "member"
      WHERE "member"."organization_id" = (SELECT current_setting('app.organization_id', true))
        AND "member"."user_id" = (SELECT current_setting('app.user_id', true))
        AND "member"."role" IN ('owner', 'admin')
    )
    AND "time_timers"."state" = 'running');--> statement-breakpoint
CREATE POLICY "organization_admin_delete" ON "time_timers" AS PERMISSIVE FOR DELETE TO stella
  USING ("time_timers"."organization_id" = (SELECT current_setting('app.organization_id', true))
    AND EXISTS (
      SELECT 1 FROM "member"
      WHERE "member"."organization_id" = (SELECT current_setting('app.organization_id', true))
        AND "member"."user_id" = (SELECT current_setting('app.user_id', true))
        AND "member"."role" IN ('owner', 'admin')
    )
    AND "time_timers"."state" = 'running');--> statement-breakpoint
CREATE POLICY "organization_admin_select" ON "time_timer_confirmations" AS PERMISSIVE FOR SELECT TO stella
  USING ("time_timer_confirmations"."organization_id" = (SELECT current_setting('app.organization_id', true))
    AND EXISTS (
      SELECT 1 FROM "member"
      WHERE "member"."organization_id" = (SELECT current_setting('app.organization_id', true))
        AND "member"."user_id" = (SELECT current_setting('app.user_id', true))
        AND "member"."role" IN ('owner', 'admin')
    ));--> statement-breakpoint
CREATE POLICY "organization_admin_insert" ON "time_timer_confirmations" AS PERMISSIVE FOR INSERT TO stella
  WITH CHECK ("time_timer_confirmations"."organization_id" = (SELECT current_setting('app.organization_id', true))
    AND EXISTS (
      SELECT 1 FROM "member"
      WHERE "member"."organization_id" = (SELECT current_setting('app.organization_id', true))
        AND "member"."user_id" = (SELECT current_setting('app.user_id', true))
        AND "member"."role" IN ('owner', 'admin')
    )
    AND EXISTS (
      SELECT 1 FROM "member"
      WHERE "member"."organization_id" = "time_timer_confirmations"."organization_id"
        AND "member"."user_id" = "time_timer_confirmations"."user_id"
    )
    AND "time_timer_confirmations"."time_entry_id" IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "time_entries"
      WHERE "time_entries"."id" = "time_timer_confirmations"."time_entry_id"
        AND "time_entries"."organization_id" = "time_timer_confirmations"."organization_id"
        AND "time_entries"."user_id" = "time_timer_confirmations"."user_id"
    ));--> statement-breakpoint
CREATE INDEX "time_timers_running_org_id_idx" ON "time_timers" ("organization_id", "id") WHERE "state" = 'running';--> statement-breakpoint
