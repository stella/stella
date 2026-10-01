SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "organization_settings"
  ADD COLUMN IF NOT EXISTS "managed_ai_residency" text NOT NULL DEFAULT 'eu';--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'organization_settings_managed_ai_residency_check'
      AND conrelid = 'organization_settings'::regclass
  ) THEN
    ALTER TABLE "organization_settings"
      ADD CONSTRAINT "organization_settings_managed_ai_residency_check"
        CHECK ("managed_ai_residency" IN ('eu', 'us')) NOT VALID;
  END IF;
END
$$;--> statement-breakpoint
-- Release the column-add lock before validating existing settings.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "organization_settings"
  VALIDATE CONSTRAINT "organization_settings_managed_ai_residency_check";
