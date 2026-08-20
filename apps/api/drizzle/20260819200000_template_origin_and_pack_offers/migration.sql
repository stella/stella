SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Where a template's first version came from. Existing rows were all
-- created in-app, so the defaults describe them; pack installs write the
-- 'bundled-pack' shape. The CHECKs bind the discriminator column to the
-- JSON payload so the two cannot drift.
ALTER TABLE "templates"
  ADD COLUMN "origin_type" text DEFAULT 'authored' NOT NULL;--> statement-breakpoint
ALTER TABLE "templates"
  ADD COLUMN "origin" jsonb DEFAULT '{"type":"authored"}'::jsonb NOT NULL;--> statement-breakpoint

ALTER TABLE "templates"
  ADD CONSTRAINT "templates_origin_type_values_check"
  CHECK ("origin_type" IN ('authored', 'bundled-pack'))
  NOT VALID;--> statement-breakpoint
-- COALESCE is load-bearing: a missing key makes its comparison NULL, and a
-- CHECK admits NULL, so without it an absent member would pass.
ALTER TABLE "templates"
  ADD CONSTRAINT "templates_origin_shape_check"
  CHECK (COALESCE(
    ("origin_type" = 'authored' AND "origin" = '{"type":"authored"}'::jsonb)
    OR (
      "origin_type" = 'bundled-pack'
      AND "origin"->>'type' = 'bundled-pack'
      AND "origin"->>'packId' IS NOT NULL
      AND "origin"->>'packVersion' IS NOT NULL
      AND "origin"->>'slug' IS NOT NULL
      AND "origin"->>'contentHash' IS NOT NULL
      AND "origin"->>'license' IS NOT NULL
      AND jsonb_typeof("origin"->'authors') = 'array'
    ),
    false
  ))
  NOT VALID;--> statement-breakpoint

-- Whether the bundled template-pack catalogue is offered to the organization.
ALTER TABLE "organization_settings"
  ADD COLUMN "template_packs_hidden" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- Validate outside the migrator transaction so the scan does not hold the
-- ADD CONSTRAINT lock; every existing row carries the defaults and passes.
-- Safe to re-run: validating an already-valid constraint is a no-op.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
ALTER TABLE "templates" VALIDATE CONSTRAINT "templates_origin_type_values_check";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
ALTER TABLE "templates" VALIDATE CONSTRAINT "templates_origin_shape_check";--> statement-breakpoint

-- One copy of a pack template per organization: a repeat install is a no-op
-- at the database, not only at the handler. IF NOT EXISTS keeps a retry
-- idempotent, and the REINDEX repairs the INVALID index a cancelled
-- concurrent build leaves behind.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "templates_org_pack_template_uidx"
  ON "templates" ("organization_id", ("origin"->>'packId'), ("origin"->>'slug'))
  WHERE "origin_type" = 'bundled-pack';--> statement-breakpoint
REINDEX INDEX CONCURRENTLY "templates_org_pack_template_uidx";--> statement-breakpoint

SET statement_timeout = '5s';--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
