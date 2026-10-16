SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "case_law_provision_citations" ALTER COLUMN "work_number" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "case_law_provision_citations" ALTER COLUMN "work_year" DROP NOT NULL;

--> statement-breakpoint
ALTER TABLE "case_law_provision_citations" ADD CONSTRAINT "provision_citations_work_number_shape" CHECK (
  CASE WHEN jurisdiction = 'EU' AND work_identifier IN ('12016M/TXT', '12016E/TXT', '12016P/TXT')
    THEN work_number IS NULL AND work_year IS NULL
    ELSE work_number IS NOT NULL AND work_year IS NOT NULL END
) NOT VALID;
--> statement-breakpoint
ALTER TABLE "case_law_provision_citations" ADD CONSTRAINT "provision_citations_eu_work_identity" CHECK (
  jurisdiction <> 'EU' OR (
    work_collection = 'EUR-Lex' AND work_eli IS NOT NULL
    AND (work_identifier IN ('12016M/TXT', '12016E/TXT', '12016P/TXT')
      OR work_identifier ~ '^3[0-9]{4}[LR][0-9]{4}$'))
) NOT VALID;
