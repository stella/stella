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

-- Build the per-organization external identity keys without holding the DDL
-- transaction's locks through the scans. IF NOT EXISTS keeps a retry
-- idempotent, the REINDEX repairs the INVALID index a cancelled build leaves
-- behind, and the online migration phase validates each on boot.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "contacts_org_external_uidx" ON "contacts" ("organization_id", "external_source", "external_id") WHERE "external_id" IS NOT NULL;--> statement-breakpoint
REINDEX INDEX CONCURRENTLY "contacts_org_external_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "workspaces_org_external_uidx" ON "workspaces" ("organization_id", "external_source", "external_id") WHERE "external_id" IS NOT NULL;--> statement-breakpoint
REINDEX INDEX CONCURRENTLY "workspaces_org_external_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "time_entries_org_external_uidx" ON "time_entries" ("organization_id", "external_source", "external_id") WHERE "external_id" IS NOT NULL;--> statement-breakpoint
REINDEX INDEX CONCURRENTLY "time_entries_org_external_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "expenses_org_external_uidx" ON "expenses" ("organization_id", "external_source", "external_id") WHERE "external_id" IS NOT NULL;--> statement-breakpoint
REINDEX INDEX CONCURRENTLY "expenses_org_external_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "invoices_org_external_uidx" ON "invoices" ("organization_id", "external_source", "external_id") WHERE "external_id" IS NOT NULL;--> statement-breakpoint
REINDEX INDEX CONCURRENTLY "invoices_org_external_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "correspondence_org_external_uidx" ON "correspondence" ("organization_id", "external_source", "external_id") WHERE "external_id" IS NOT NULL;--> statement-breakpoint
REINDEX INDEX CONCURRENTLY "correspondence_org_external_uidx";--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;--> statement-breakpoint
-- A ref is whole and stamped with its import time. Every existing row has
-- three NULL columns, so the next migration validates without a violation.
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_external_ref_check" CHECK (("external_source" IS NULL) = ("external_id" IS NULL) AND ("external_id" IS NULL OR "imported_at" IS NOT NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_external_ref_check" CHECK (("external_source" IS NULL) = ("external_id" IS NULL) AND ("external_id" IS NULL OR "imported_at" IS NOT NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_external_ref_check" CHECK (("external_source" IS NULL) = ("external_id" IS NULL) AND ("external_id" IS NULL OR "imported_at" IS NOT NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_external_ref_check" CHECK (("external_source" IS NULL) = ("external_id" IS NULL) AND ("external_id" IS NULL OR "imported_at" IS NOT NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_external_ref_check" CHECK (("external_source" IS NULL) = ("external_id" IS NULL) AND ("external_id" IS NULL OR "imported_at" IS NOT NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "correspondence" ADD CONSTRAINT "correspondence_external_ref_check" CHECK (("external_source" IS NULL) = ("external_id" IS NULL) AND ("external_id" IS NULL OR "imported_at" IS NOT NULL)) NOT VALID;
