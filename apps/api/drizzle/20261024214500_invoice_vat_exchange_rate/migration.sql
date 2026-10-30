SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Additive, nullable metadata: existing invoices need no table rewrite or backfill.
ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "vat_exchange_rate" numeric(24, 12),
  ADD COLUMN IF NOT EXISTS "vat_exchange_rate_source" varchar(8),
  ADD COLUMN IF NOT EXISTS "vat_exchange_rate_date" date,
  ADD COLUMN IF NOT EXISTS "vat_exchange_rate_reference" varchar(64),
  ADD COLUMN IF NOT EXISTS "vat_exchange_rate_tax_point" date;
