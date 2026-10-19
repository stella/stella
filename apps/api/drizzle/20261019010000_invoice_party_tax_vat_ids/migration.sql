SET lock_timeout = '5s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "seller_profiles" ADD COLUMN "tax_id" varchar(64);--> statement-breakpoint
ALTER TABLE "seller_profiles" ADD COLUMN "register_entry" text;--> statement-breakpoint
ALTER TABLE "seller_profiles" ADD COLUMN "bar_registration" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "vat_id" varchar(64);--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "vat_payer" boolean;--> statement-breakpoint
-- Only values in an EU VAT ID format move to vat_id: a member-state prefix
-- followed by that state's number shape, matching the shared VIES validator in
-- packages/business-registries/src/vies/validation.ts. Register numbers
-- such as HRB123456 stay tax IDs.
UPDATE "contacts"
SET "vat_id" = "tax_id", "tax_id" = NULL
WHERE upper(regexp_replace("tax_id", '[[:space:].-]', '', 'g')) ~ '^(ATU[0-9]{8}|BE[01][0-9]{9}|BG[0-9]{9,10}|CY[0-9]{8}[A-Z]|CZ[0-9]{8,10}|DE[0-9]{9}|DK[0-9]{8}|EE[0-9]{9}|EL[0-9]{9}|ES[0-9A-Z][0-9]{7}[0-9A-Z]|FI[0-9]{8}|FR[A-HJ-NP-Z0-9]{2}[0-9]{9}|HR[0-9]{11}|HU[0-9]{8}|IE([0-9][0-9A-Z*+][0-9]{5}[A-W]|[0-9]{7}[A-W][A-I]?)|IT[0-9]{11}|LT([0-9]{9}|[0-9]{12})|LU[0-9]{8}|LV[0-9]{11}|MT[0-9]{8}|NL[0-9]{9}B[0-9]{2}|PL[0-9]{10}|PT[0-9]{9}|RO[0-9]{2,10}|SE[0-9]{12}|SI[0-9]{8}|SK[0-9]{10}|XI([0-9]{9}|[0-9]{12}|GD[0-9]{3}|HA[0-9]{3}))$';--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "buyer_tax_id" varchar(64);
