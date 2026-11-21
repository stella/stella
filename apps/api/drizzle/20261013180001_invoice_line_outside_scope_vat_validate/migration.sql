SET lock_timeout = '1s';
--> statement-breakpoint
-- Validated apart from the NOT VALID add so the scan holds only a
-- SHARE UPDATE EXCLUSIVE lock and normal reads and writes continue.
SET statement_timeout = 0;
--> statement-breakpoint
ALTER TABLE "invoice_lines"
  VALIDATE CONSTRAINT "invoice_lines_vat_treatment_check";
--> statement-breakpoint
SET statement_timeout = '5s';
