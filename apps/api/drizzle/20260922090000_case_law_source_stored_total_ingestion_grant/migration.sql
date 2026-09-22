SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- `stella_ingestion` holds UPDATE on "case_law_sources" column by column, and
-- 20260919140000_case_law_source_stored_total added the two stored-total
-- columns without naming the role: it granted SELECT on them to
-- stella_public_law_reader and stopped there. The pair's only writer,
-- refreshSourceStoredTotal, was refused with 42501 on every sync cycle and
-- logged case_law.source_stored_total.unavailable instead of counting, so the
-- stored half of every source's coverage figure stayed NULL.
--
-- SELECT is not repeated here: the role already holds it on the whole table.
GRANT UPDATE (stored_total, stored_total_as_of)
  ON TABLE "case_law_sources"
  TO stella_ingestion;
