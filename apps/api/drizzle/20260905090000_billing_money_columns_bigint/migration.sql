SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

-- Widening alone, in its own migration.
--
-- `ALTER ... TYPE bigint` rewrites the table under ACCESS EXCLUSIVE, and each
-- migration file commits on its own, so keeping these five statements apart
-- from the data rescale that follows them means the exclusive locks are
-- released before the rescale takes its row locks instead of both being held
-- for the length of one transaction.
--
-- The rescale in `20260905091000_billing_true_minor_units` depends on this
-- having run: it writes values `integer` cannot hold.

-- `integer` cannot hold what this migration writes. CLF has four decimal
-- places, so a stored amount above 21,474,836 hundredths becomes more than
-- 2^31-1 once it is multiplied by a hundred, and the rescale would abort the
-- deployment on overflow rather than silently truncate. `bigint` removes the
-- ceiling from the column; `bigint({ mode: "number" })` keeps the TypeScript
-- type `number`, and the write boundaries cap the value at
-- Number.MAX_SAFE_INTEGER, which is the real limit either way.
--
-- Every money column declared with `centsColumn` moves together, including
-- `contacts.default_hourly_rate`, so the helper stays one declaration and
-- `db:push --explain` reports no drift.
--
-- These tables scale with workspaces, not with the corpus: none is registered
-- in apps/api/src/db/high-volume-tables.ts, and each rewrite runs under the
-- statement timeout above.
-- stella-migration-safety: bounded-type-rewrite
-- stella-migration-safety: reviewed alter-column-type - int4 to int8 is a widening on small, workspace-scoped billing tables; no value loses precision and no read path narrows.
ALTER TABLE "time_entries" ALTER COLUMN "rate_at_entry" TYPE bigint;--> statement-breakpoint
-- stella-migration-safety: bounded-type-rewrite
-- stella-migration-safety: reviewed alter-column-type - int4 to int8 is a widening on small, workspace-scoped billing tables; no value loses precision and no read path narrows.
ALTER TABLE "rate_entries" ALTER COLUMN "hourly_rate" TYPE bigint;--> statement-breakpoint
-- stella-migration-safety: bounded-type-rewrite
-- stella-migration-safety: reviewed alter-column-type - int4 to int8 is a widening on small, workspace-scoped billing tables; no value loses precision and no read path narrows.
ALTER TABLE "expenses" ALTER COLUMN "amount" TYPE bigint;--> statement-breakpoint
-- stella-migration-safety: bounded-type-rewrite
-- stella-migration-safety: reviewed alter-column-type - int4 to int8 is a widening on small, workspace-scoped billing tables; no value loses precision and no read path narrows.
ALTER TABLE "invoices" ALTER COLUMN "total_amount" TYPE bigint;--> statement-breakpoint
-- stella-migration-safety: bounded-type-rewrite
-- stella-migration-safety: reviewed alter-column-type - int4 to int8 is a widening on small, workspace-scoped billing tables; no value loses precision and no read path narrows.
ALTER TABLE "contacts" ALTER COLUMN "default_hourly_rate" TYPE bigint;
