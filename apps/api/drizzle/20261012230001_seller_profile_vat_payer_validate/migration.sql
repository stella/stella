SET lock_timeout = '1s';
--> statement-breakpoint
-- Validated apart from the NOT VALID add so the scan holds only a
-- SHARE UPDATE EXCLUSIVE lock and normal reads and writes continue.
SET statement_timeout = '10s';
--> statement-breakpoint
ALTER TABLE "seller_profiles"
  VALIDATE CONSTRAINT "seller_profiles_vat_payer_check";
