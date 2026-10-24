SET lock_timeout = '5s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "invoice_language" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "invoice_language" text;--> statement-breakpoint
-- Every existing invoice was issued without a stored language; English is the
-- fallback the organisation default would have resolved to.
ALTER TABLE "invoices" ADD COLUMN "language" text NOT NULL DEFAULT 'en';--> statement-breakpoint
-- The checks are validated online after deployment (invoice-language-constraint-validation.ts).
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_language_check" CHECK ("language" IN ('ar', 'cs', 'de', 'en', 'es', 'et', 'fr', 'hu', 'lt', 'lv', 'pl', 'pt-BR', 'sk')) NOT VALID;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_invoice_language_check" CHECK ("invoice_language" IS NULL OR "invoice_language" IN ('ar', 'cs', 'de', 'en', 'es', 'et', 'fr', 'hu', 'lt', 'lv', 'pl', 'pt-BR', 'sk')) NOT VALID;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_invoice_language_check" CHECK ("invoice_language" IS NULL OR "invoice_language" IN ('ar', 'cs', 'de', 'en', 'es', 'et', 'fr', 'hu', 'lt', 'lv', 'pl', 'pt-BR', 'sk')) NOT VALID;
