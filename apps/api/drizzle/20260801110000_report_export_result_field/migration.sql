SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Additive and nullable for existing report-export receipts. A field can be
-- deleted with its source version, so preserve the receipt and clear only the
-- direct-link hint.
ALTER TABLE "report_exports"
  ADD COLUMN IF NOT EXISTS "result_field_id" uuid;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'report_exports_result_field_fk'
  ) THEN
    ALTER TABLE "report_exports"
      ADD CONSTRAINT "report_exports_result_field_fk"
      FOREIGN KEY ("result_field_id") REFERENCES "fields"("id") ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
