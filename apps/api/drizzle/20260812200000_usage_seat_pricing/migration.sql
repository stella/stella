SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- How a catalog price applies: one price for the whole organisation
-- (`flat`) or multiplied by purchased seats (`per_seat`). Existing rows
-- are flat-priced, which the default expresses without a backfill.
ALTER TABLE "usage_policies"
  ADD COLUMN IF NOT EXISTS "price_basis" text DEFAULT 'flat' NOT NULL;--> statement-breakpoint

-- Validating immediately: the catalog is operator-seeded and bounded at
-- 100 rows, so the scan is instant and NOT VALID + VALIDATE buys nothing.
ALTER TABLE "usage_policies"
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "usage_policies_price_basis_domain"
  CHECK (price_basis IN ('flat', 'per_seat'));--> statement-breakpoint

-- Highest seat count applied inside the entitlement's current period,
-- maintained by the hosted webhook dispatcher and reset on period
-- rollover. Pro-rata unit deltas are granted only when seats exceed
-- this peak, so cycling seats down and back up inside one period
-- cannot mint capacity twice. Null (including all pre-existing rows)
-- reads as "peak = seats".
ALTER TABLE "usage_entitlements"
  ADD COLUMN IF NOT EXISTS "hosted_peak_seats" integer;--> statement-breakpoint

-- Validating immediately for the same reason: at most one entitlement
-- row per organisation, and the new column is NULL everywhere.
ALTER TABLE "usage_entitlements"
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "usage_entitlements_hosted_peak_seats_positive"
  CHECK (hosted_peak_seats IS NULL OR hosted_peak_seats > 0);
