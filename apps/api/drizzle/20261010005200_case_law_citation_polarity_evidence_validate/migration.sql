-- requires: 20261010005100_case_law_polarity_kind_evidence
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5min';--> statement-breakpoint

-- One row per citation, so the scan tracks corpus volume rather than how
-- recently the columns were created: the five-second bound every schema
-- change here carries would abort it. Its own migration, so the scan holds
-- only SHARE UPDATE EXCLUSIVE on this table, and a timeout fails this
-- statement alone and is retried by rerunning it. Validate the four checks
-- together so PostgreSQL scans the corpus once.
ALTER TABLE "case_law_citations"
  VALIDATE CONSTRAINT "citations_polarity_source_values",
  VALIDATE CONSTRAINT "citations_cited_part_values",
  VALIDATE CONSTRAINT "citations_polarity_window_bounds",
  VALIDATE CONSTRAINT "citations_polarity_confidence_bounds";
