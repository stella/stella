ALTER TABLE "organization_settings" ADD COLUMN "document_processing_mode" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_document_processing_mode_check" CHECK ("organization_settings"."document_processing_mode" IN ('off', 'searchable-text'));
