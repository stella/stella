SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "document_processing_mode" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_document_processing_mode_check" CHECK ("organization_settings"."document_processing_mode" IN ('off', 'searchable-text')) NOT VALID;--> statement-breakpoint
-- Release the ACCESS EXCLUSIVE lock before validating existing rows.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "organization_settings" VALIDATE CONSTRAINT "organization_settings_document_processing_mode_check";
