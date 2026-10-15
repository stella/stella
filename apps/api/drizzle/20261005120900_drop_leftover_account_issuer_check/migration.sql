-- requires: 20260916140000_account_issuer_nullable
SET lock_timeout = '2s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

-- 20260825220000_better_auth_17_constraints adds a temporary NOT NULL proof
-- for `account.issuer` and drops it once the column is promoted. A database
-- where that last step did not take effect still carries the check after
-- 20260916140000_account_issuer_nullable relaxed the column, so it rejects
-- every account the current library writes (it no longer sets `issuer`).
-- Dropping it by name is a no-op where it is already gone; DROP CONSTRAINT is
-- catalog-only and the 2s lock_timeout keeps the release retryable.
-- stella-migration-safety: reviewed drop-constraint - removes only a leftover temporary proof that no migration intends to keep; no row data is touched, and re-adding it would reject every new account, so there is nothing to roll back to.
ALTER TABLE "account"
  DROP CONSTRAINT IF EXISTS "account_issuer_not_null_check";
