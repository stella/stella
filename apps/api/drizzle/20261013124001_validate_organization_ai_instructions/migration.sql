SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

-- Validate after creation commits, so the scan does not hold the creation lock.
ALTER TABLE "organization_settings"
  VALIDATE CONSTRAINT "organization_settings_ai_instructions_length_check";
