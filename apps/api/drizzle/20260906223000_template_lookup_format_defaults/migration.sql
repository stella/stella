SET lock_timeout = '5s';
--> statement-breakpoint
SET statement_timeout = '30s';
--> statement-breakpoint
ALTER TABLE "template_lookup_formats" ADD COLUMN "preference" text DEFAULT 'saved' NOT NULL;
--> statement-breakpoint
-- The table is created empty earlier in this release, before API versions that can write it.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE "template_lookup_formats" ADD CONSTRAINT "template_lookup_formats_preference_check" CHECK ("preference" IN ('saved', 'default'));
--> statement-breakpoint
-- This table is introduced in this release; previously deployed API versions cannot write it.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX "template_lookup_formats_org_registry_default_idx" ON "template_lookup_formats" ("organization_id", "registry") WHERE "preference" = 'default';
