SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

-- Validate after the NOT VALID constraints commit, so validation does not
-- hold their creation lock for the duration of the scan.
ALTER TABLE "organization_settings" VALIDATE CONSTRAINT "organization_settings_time_minimum_unit_check";--> statement-breakpoint
ALTER TABLE "organization_settings" VALIDATE CONSTRAINT "organization_settings_time_edit_window_check";--> statement-breakpoint
ALTER TABLE "organization_settings" VALIDATE CONSTRAINT "organization_settings_time_locked_month_check";
