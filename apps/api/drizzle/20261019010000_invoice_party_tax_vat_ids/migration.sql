ALTER TABLE "seller_profiles" ADD COLUMN "tax_id" varchar(64);--> statement-breakpoint
ALTER TABLE "seller_profiles" ADD COLUMN "register_entry" text;--> statement-breakpoint
ALTER TABLE "seller_profiles" ADD COLUMN "bar_registration" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "vat_id" varchar(64);--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "vat_payer" boolean;--> statement-breakpoint
-- Values carrying a two-letter country prefix are VAT IDs. Keep national,
-- unprefixed identifiers as tax IDs.
UPDATE "contacts"
SET "vat_id" = "tax_id", "tax_id" = NULL
WHERE upper(regexp_replace("tax_id", '[[:space:].-]', '', 'g')) ~ '^[A-Z]{2}[0-9A-Z]{2,}$';--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "buyer_tax_id" varchar(64);
