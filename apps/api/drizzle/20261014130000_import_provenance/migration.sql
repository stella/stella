SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

-- Where an imported row came from. Nullable with no default, so adding the
-- columns rewrites no row.
ALTER TABLE "contacts"
  ADD COLUMN IF NOT EXISTS "external_source" varchar(64),
  ADD COLUMN IF NOT EXISTS "external_id" varchar(256),
  ADD COLUMN IF NOT EXISTS "imported_at" timestamptz;--> statement-breakpoint
ALTER TABLE "workspaces"
  ADD COLUMN IF NOT EXISTS "external_source" varchar(64),
  ADD COLUMN IF NOT EXISTS "external_id" varchar(256),
  ADD COLUMN IF NOT EXISTS "imported_at" timestamptz;--> statement-breakpoint
ALTER TABLE "time_entries"
  ADD COLUMN IF NOT EXISTS "external_source" varchar(64),
  ADD COLUMN IF NOT EXISTS "external_id" varchar(256),
  ADD COLUMN IF NOT EXISTS "imported_at" timestamptz;--> statement-breakpoint
ALTER TABLE "expenses"
  ADD COLUMN IF NOT EXISTS "external_source" varchar(64),
  ADD COLUMN IF NOT EXISTS "external_id" varchar(256),
  ADD COLUMN IF NOT EXISTS "imported_at" timestamptz;--> statement-breakpoint
ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "external_source" varchar(64),
  ADD COLUMN IF NOT EXISTS "external_id" varchar(256),
  ADD COLUMN IF NOT EXISTS "imported_at" timestamptz;--> statement-breakpoint
ALTER TABLE "correspondence"
  ADD COLUMN IF NOT EXISTS "external_source" varchar(64),
  ADD COLUMN IF NOT EXISTS "external_id" varchar(256),
  ADD COLUMN IF NOT EXISTS "imported_at" timestamptz;--> statement-breakpoint

-- The online phase builds and verifies the external identity indexes
-- concurrently after this additive DDL transaction commits.
-- A ref is whole and stamped with its import time. Every existing row has
-- three NULL columns; the online phase validates after DDL locks are released.
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_external_ref_check" CHECK (("external_source" IS NULL) = ("external_id" IS NULL) AND ("external_id" IS NULL OR "imported_at" IS NOT NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_external_ref_check" CHECK (("external_source" IS NULL) = ("external_id" IS NULL) AND ("external_id" IS NULL OR "imported_at" IS NOT NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_external_ref_check" CHECK (("external_source" IS NULL) = ("external_id" IS NULL) AND ("external_id" IS NULL OR "imported_at" IS NOT NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_external_ref_check" CHECK (("external_source" IS NULL) = ("external_id" IS NULL) AND ("external_id" IS NULL OR "imported_at" IS NOT NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_external_ref_check" CHECK (("external_source" IS NULL) = ("external_id" IS NULL) AND ("external_id" IS NULL OR "imported_at" IS NOT NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "correspondence" ADD CONSTRAINT "correspondence_external_ref_check" CHECK (("external_source" IS NULL) = ("external_id" IS NULL) AND ("external_id" IS NULL OR "imported_at" IS NOT NULL)) NOT VALID;
