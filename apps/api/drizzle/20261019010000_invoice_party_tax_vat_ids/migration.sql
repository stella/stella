SET lock_timeout = '5s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "seller_profiles" ADD COLUMN "tax_id" varchar(64);--> statement-breakpoint
ALTER TABLE "seller_profiles" ADD COLUMN "register_entry" text;--> statement-breakpoint
ALTER TABLE "seller_profiles" ADD COLUMN "bar_registration" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "vat_id" varchar(64);--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "vat_payer" boolean;--> statement-breakpoint
-- Only values in an EU VAT ID format move to vat_id: a member-state prefix
-- followed by that state's number shape (AT, ES, FR and NL have their own
-- shapes; every other state's number starts with a digit). Register numbers
-- such as HRB123456 stay tax IDs.
UPDATE "contacts"
SET "vat_id" = "tax_id", "tax_id" = NULL
WHERE upper(regexp_replace("tax_id", '[[:space:].-]', '', 'g')) ~ '^(ATU[0-9]{8}|ES[0-9A-Z][0-9]{7}[0-9A-Z]|FR[0-9A-Z]{2}[0-9]{9}|NL[0-9]{9}B[0-9]{2}|(BE|BG|CY|CZ|DE|DK|EE|EL|FI|HR|HU|IE|IT|LT|LU|LV|MT|PL|PT|RO|SE|SI|SK|XI)[0-9][0-9A-Z]{1,12})$';--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "buyer_tax_id" varchar(64);
