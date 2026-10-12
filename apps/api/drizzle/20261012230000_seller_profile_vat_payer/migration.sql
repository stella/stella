SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

-- Whether an issuer charges VAT is now recorded, not read from the VAT ID: a
-- registered person who is not a payer has a VAT ID and must not charge VAT.
ALTER TABLE "seller_profiles"
  ADD COLUMN IF NOT EXISTS "vat_payer" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- Keep today's behaviour: a profile with a VAT ID was treated as a payer.
-- Bounded by its WHERE clause; seller profiles are a handful per organization.
UPDATE "seller_profiles"
SET "vat_payer" = true
WHERE btrim(coalesce("vat_id", '')) <> '' AND NOT "vat_payer";--> statement-breakpoint

ALTER TABLE "seller_profiles" ADD CONSTRAINT "seller_profiles_vat_payer_check" CHECK (NOT "vat_payer" OR btrim(coalesce("vat_id", '')) <> '') NOT VALID;--> statement-breakpoint
ALTER TABLE "seller_profiles" VALIDATE CONSTRAINT "seller_profiles_vat_payer_check";
