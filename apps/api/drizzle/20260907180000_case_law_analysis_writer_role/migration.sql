SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Operator login that pre-computes decision analyses. It reads only the
-- columns that computation needs and writes exactly one column,
-- case_law_decisions.analysis.
CREATE ROLE stella_case_law_analysis_writer NOLOGIN;--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO stella_case_law_analysis_writer;--> statement-breakpoint

GRANT SELECT (
  id,
  source_id,
  language,
  court,
  country,
  decision_type,
  document_ast,
  content_hash,
  analysis,
  redacted_at,
  metadata,
  citation_authority,
  citation_count
) ON TABLE "case_law_decisions" TO stella_case_law_analysis_writer;--> statement-breakpoint

-- `updated_at` rides every write: the column carries `$onUpdate`, so the
-- ORM assigns it in the same statement that sets `analysis`. Without the
-- grant the whole statement is refused, which is the only reason a row's
-- timestamp is writable here.
GRANT UPDATE (analysis, updated_at)
  ON TABLE "case_law_decisions"
  TO stella_case_law_analysis_writer;--> statement-breakpoint

GRANT SELECT (id, descriptor)
  ON TABLE "case_law_sources"
  TO stella_case_law_analysis_writer;--> statement-breakpoint

CREATE POLICY "case_law_analysis_writer_read" ON "case_law_decisions"
  AS PERMISSIVE FOR SELECT TO "stella_case_law_analysis_writer" USING (true);--> statement-breakpoint
CREATE POLICY "case_law_analysis_writer_write" ON "case_law_decisions"
  AS PERMISSIVE FOR UPDATE TO "stella_case_law_analysis_writer"
  USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "case_law_analysis_writer_read" ON "case_law_sources"
  AS PERMISSIVE FOR SELECT TO "stella_case_law_analysis_writer" USING (true);
