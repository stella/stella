SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "organization_settings"
  ADD COLUMN "managed_ai_residency" text NOT NULL DEFAULT 'eu';--> statement-breakpoint
ALTER TABLE "organization_settings"
  ADD CONSTRAINT "organization_settings_managed_ai_residency_check"
    CHECK ("managed_ai_residency" IN ('eu', 'us')) NOT VALID;--> statement-breakpoint
ALTER TABLE "organization_settings"
  VALIDATE CONSTRAINT "organization_settings_managed_ai_residency_check";
