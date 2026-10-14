SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "matter_numbering_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Organizations that exist now keep matter numbers in their titles. Only
-- organizations created later start with numbering off. One without a
-- settings row would read the column default, so it gets a row first.
INSERT INTO "organization_settings" ("id", "organization_id")
SELECT gen_random_uuid(), "organization"."id" FROM "organization"
ON CONFLICT ("organization_id") DO NOTHING;--> statement-breakpoint
UPDATE "organization_settings" SET "matter_numbering_enabled" = true;
