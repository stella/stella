-- requires: 20261016100500_account_exports
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- An export now covers either the account's own data or the audit trail of one
-- organization, requested by an owner before that organization is deleted.
-- Every existing row is an account export, which the constant default records
-- without reading a row.
ALTER TABLE "account_exports"
  ADD COLUMN "kind" text DEFAULT 'account' NOT NULL;--> statement-breakpoint

-- The organization an organization audit export covers. No reference to the
-- organization: the row belongs to the requesting account and stays
-- downloadable after that organization is gone.
ALTER TABLE "account_exports"
  ADD COLUMN "organization_id" varchar(128);--> statement-breakpoint

-- What a ready organization audit archive holds: its row count and the
-- creation time of its newest row. Deletion compares the count with the live
-- trail inside its own transaction.
ALTER TABLE "account_exports"
  ADD COLUMN "audit_row_count" integer;--> statement-breakpoint
ALTER TABLE "account_exports"
  ADD COLUMN "audit_covered_through" timestamp with time zone;--> statement-breakpoint

-- Added validating rather than NOT VALID + VALIDATE: every existing row holds
-- the defaults the columns were just created with, and account_exports holds a
-- few rows per account, bounded by the hourly request budget.
ALTER TABLE "account_exports"
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "account_exports_kind_check"
  CHECK ("kind" IN ('account', 'organization_audit'));--> statement-breakpoint
ALTER TABLE "account_exports"
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "account_exports_kind_scope_check"
  CHECK (
    ("kind" = 'account' AND "organization_id" IS NULL AND "audit_row_count" IS NULL AND "audit_covered_through" IS NULL)
    OR ("kind" = 'organization_audit' AND "organization_id" IS NOT NULL
      AND ("status" <> 'ready' OR ("audit_row_count" IS NOT NULL AND "audit_row_count" >= 0)))
  );--> statement-breakpoint

-- One active export per account for its own data, and one per account and
-- organization for an audit trail. Every existing row is an account export, so
-- the narrower account index admits exactly what the old one admitted.
-- account_exports is small (see above), so the build is short and
-- lock_timeout bounds the wait for its lock.
-- stella-migration-safety: reviewed add-unique-constraint - writers: apps/api/src/lib/account-export/store.ts; every existing row is an account export, so this partial index enforces exactly the uniqueness the index it replaces already enforced.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX "account_exports_user_account_active_idx" ON "account_exports" ("user_id") WHERE "kind" = 'account' AND "status" IN ('requested', 'processing', 'ready');--> statement-breakpoint
-- stella-migration-safety: reviewed add-unique-constraint - writers: apps/api/src/lib/account-export/store.ts; a new export kind with no existing rows, one active audit export per account and organization.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX "account_exports_user_organization_audit_active_idx" ON "account_exports" ("user_id", "organization_id") WHERE "kind" = 'organization_audit' AND "status" IN ('requested', 'processing', 'ready');--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - replaced by account_exports_user_account_active_idx above, which enforces the same rule for account exports and leaves organization audit exports to their own index.
-- squawk-ignore require-concurrent-index-deletion
DROP INDEX IF EXISTS "account_exports_user_active_idx";
