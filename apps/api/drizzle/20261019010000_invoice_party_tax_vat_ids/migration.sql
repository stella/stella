SET lock_timeout = '5s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "seller_profiles" ADD COLUMN "tax_id" varchar(64);--> statement-breakpoint
ALTER TABLE "seller_profiles" ADD COLUMN "register_entry" text;--> statement-breakpoint
ALTER TABLE "seller_profiles" ADD COLUMN "bar_registration" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "vat_id" varchar(64);--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "vat_payer" boolean;--> statement-breakpoint
-- EU-format VAT numbers already stored in tax_id move to vat_id in the online
-- phase (apps/api/src/db/contact-vat-id-repair.ts); until then readers treat
-- them as the VAT ID.
ALTER TABLE "invoices" ADD COLUMN "buyer_tax_id" varchar(64);
