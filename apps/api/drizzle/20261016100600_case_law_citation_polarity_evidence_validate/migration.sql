-- requires: 20261016100500_case_law_polarity_kind_evidence
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5min';--> statement-breakpoint

-- Validate after the schema migration commits so the scans do not retain
-- its ACCESS EXCLUSIVE locks. The rule registry is small; combine its checks
-- into one scan under SHARE UPDATE EXCLUSIVE.
ALTER TABLE "case_law_polarity_rules"
  VALIDATE CONSTRAINT "polarity_rules_kind_values",
  VALIDATE CONSTRAINT "polarity_rules_form_neutral";--> statement-breakpoint

-- One row per citation, so the scan tracks corpus volume rather than how
-- recently the columns were created: the five-second bound every schema
-- change carries would abort it. This separate validation migration holds
-- only SHARE UPDATE EXCLUSIVE; a timeout aborts this migration, and rerunning
-- it retries both scans. Validate the four citation checks together so
-- PostgreSQL scans the corpus once.
ALTER TABLE "case_law_citations"
  VALIDATE CONSTRAINT "citations_polarity_source_values",
  VALIDATE CONSTRAINT "citations_cited_part_values",
  VALIDATE CONSTRAINT "citations_polarity_window_bounds",
  VALIDATE CONSTRAINT "citations_polarity_confidence_bounds";
