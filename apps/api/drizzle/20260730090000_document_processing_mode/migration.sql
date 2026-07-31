SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- The validation below runs after an explicit COMMIT. If it times out, this
-- additive phase has already committed and the migrator retries this file.
ALTER TABLE "organization_settings" ADD COLUMN IF NOT EXISTS "document_processing_mode" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'organization_settings_document_processing_mode_check'
      AND conrelid = 'organization_settings'::regclass
  ) THEN
    ALTER TABLE "organization_settings"
      ADD CONSTRAINT "organization_settings_document_processing_mode_check"
      CHECK ("document_processing_mode" IN ('off', 'searchable-text')) NOT VALID;
  END IF;
END
$$;--> statement-breakpoint
-- Release the ACCESS EXCLUSIVE lock before validating existing rows.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "organization_settings" VALIDATE CONSTRAINT "organization_settings_document_processing_mode_check";
