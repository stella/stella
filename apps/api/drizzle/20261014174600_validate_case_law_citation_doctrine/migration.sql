-- requires: 20261014174500_case_law_citation_doctrine
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "case_law_citations" VALIDATE CONSTRAINT "citations_doctrinal_treatment_values";
