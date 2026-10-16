SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- Rows that exist now keep matter numbers in their titles; only rows written
-- after this migration start from the product default (off).
ALTER TABLE "organization_settings" ADD COLUMN "matter_numbering_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_settings" ALTER COLUMN "matter_numbering_enabled" SET DEFAULT false;--> statement-breakpoint
-- An organization without a settings row would read the product default, so
-- every organization that exists now gets a row that keeps numbering on. The
-- id is derived from the organization id, so a later from-scratch migration
-- writes the same rows.
-- stella-migration-safety: reviewed insert-select - one row per existing organization that has none (a few hundred at most, inside the 5s statement timeout); rerunning inserts nothing, and rollback is dropping the column.
INSERT INTO "organization_settings" ("id", "organization_id", "matter_numbering_enabled")
SELECT md5('organization_settings:' || "organization"."id")::uuid, "organization"."id", true
FROM "organization"
WHERE NOT EXISTS (
  SELECT 1 FROM "organization_settings"
  WHERE "organization_settings"."organization_id" = "organization"."id"
);
