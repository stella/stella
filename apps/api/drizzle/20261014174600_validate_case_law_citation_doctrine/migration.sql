-- requires: 20261014174500_case_law_citation_doctrine
-- Validating scans every citation row; the table is large, so the scan gets
-- the long-migration budget. VALIDATE takes only SHARE UPDATE EXCLUSIVE, so
-- reads and writes continue while it runs.
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30min';--> statement-breakpoint
ALTER TABLE "case_law_citations" VALIDATE CONSTRAINT "citations_doctrinal_treatment_values";
