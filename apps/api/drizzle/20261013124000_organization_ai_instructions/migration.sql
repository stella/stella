SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "organization_settings"
  ADD COLUMN "ai_instructions" text NOT NULL DEFAULT '',
  ADD CONSTRAINT "organization_settings_ai_instructions_length_check"
    CHECK (char_length("ai_instructions") <= 3000);
