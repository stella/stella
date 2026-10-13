SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

-- A service to a business client outside the EU is outside the scope of VAT
-- (place of supply abroad) and its lines record the outside_scope treatment.
-- The check only widens, so existing lines keep satisfying it; it is
-- validated in the next migration so this one takes no long lock.
ALTER TABLE "invoice_lines" DROP CONSTRAINT IF EXISTS "invoice_lines_vat_treatment_check";--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_vat_treatment_check" CHECK ("vat_treatment" in ('domestic_vat', 'not_vat_payer', 'reverse_charge', 'outside_scope', 'exempt')) NOT VALID;
