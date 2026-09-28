SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

-- Constant defaults keep existing settings rows valid without a backfill.
ALTER TABLE "organization_settings"
  ADD COLUMN "time_minimum_unit_minutes" integer DEFAULT 6 NOT NULL,
  ADD COLUMN "time_edit_window_days" integer DEFAULT 90 NOT NULL,
  ADD COLUMN "time_locked_through_month" date,
  ADD COLUMN "time_narrative_required" boolean DEFAULT true NOT NULL;--> statement-breakpoint

-- Guard direct writes with the same domain limits as the settings endpoint.
ALTER TABLE "organization_settings"
  ADD CONSTRAINT "organization_settings_time_minimum_unit_check"
    CHECK ("time_minimum_unit_minutes" > 0 AND 60 % "time_minimum_unit_minutes" = 0) NOT VALID,
  ADD CONSTRAINT "organization_settings_time_edit_window_check"
    CHECK ("time_edit_window_days" >= 0) NOT VALID,
  ADD CONSTRAINT "organization_settings_time_locked_month_check"
    CHECK ("time_locked_through_month" IS NULL OR (isfinite("time_locked_through_month") AND EXTRACT(MONTH FROM "time_locked_through_month" + 1) <> EXTRACT(MONTH FROM "time_locked_through_month"))) NOT VALID;--> statement-breakpoint

-- Validation scans existing rows without holding the ADD CONSTRAINT lock.
ALTER TABLE "organization_settings" VALIDATE CONSTRAINT "organization_settings_time_minimum_unit_check";--> statement-breakpoint
ALTER TABLE "organization_settings" VALIDATE CONSTRAINT "organization_settings_time_edit_window_check";--> statement-breakpoint
ALTER TABLE "organization_settings" VALIDATE CONSTRAINT "organization_settings_time_locked_month_check";
