SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
-- Expand only: old API tasks retain their non-null integer contract. EU writers
-- put meaningful numbers in the new columns; the legacy zero defaults are rollout
-- slots, never EU identities. Remove them only after every reader/writer cuts over.
ALTER TABLE "case_law_provision_citations"
  ADD COLUMN "eu_work_number" integer,
  ADD COLUMN "eu_work_year" smallint,
  ALTER COLUMN "work_number" SET DEFAULT 0,
  ALTER COLUMN "work_year" SET DEFAULT 0;

--> statement-breakpoint
ALTER TABLE "case_law_provision_citations" ADD CONSTRAINT "provision_citations_work_number_shape" CHECK (
  CASE WHEN jurisdiction = 'EU' AND work_identifier IN ('12016M/TXT', '12016E/TXT', '12016P/TXT')
    THEN eu_work_number IS NULL AND eu_work_year IS NULL
    WHEN jurisdiction = 'EU' THEN eu_work_number IS NOT NULL AND eu_work_year IS NOT NULL
    ELSE eu_work_number IS NULL AND eu_work_year IS NULL AND work_number > 0 AND work_year > 0 END
) NOT VALID;
--> statement-breakpoint
ALTER TABLE "case_law_provision_citations" ADD CONSTRAINT "provision_citations_eu_work_identity" CHECK (
  jurisdiction <> 'EU' OR (
    work_collection = 'EUR-Lex' AND work_eli IS NOT NULL
    AND (work_identifier IN ('12016M/TXT', '12016E/TXT', '12016P/TXT')
      OR work_identifier ~ '^3[0-9]{4}[LR][0-9]{4}$'))
) NOT VALID;

--> statement-breakpoint
GRANT SELECT ("eu_work_number", "eu_work_year") ON TABLE "case_law_provision_citations" TO "stella_public_law_reader";
