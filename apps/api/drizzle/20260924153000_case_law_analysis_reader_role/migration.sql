SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Read-only role for internal case-law analysis. It reads a narrow column set
-- of the corpus relations below and holds nothing else.
CREATE ROLE stella_case_law_analysis_reader NOLOGIN;--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO stella_case_law_analysis_reader;--> statement-breakpoint

GRANT SELECT (
  id,
  citing_decision_id,
  cited_decision_id,
  citation_text,
  section_index,
  polarity,
  polarity_rule_id,
  kind
) ON TABLE "case_law_citations" TO stella_case_law_analysis_reader;--> statement-breakpoint

GRANT SELECT (
  id,
  case_number,
  decision_date,
  citation_authority,
  sections,
  normalized_s3_key,
  court,
  text_s3_key,
  country,
  language
) ON TABLE "case_law_decisions" TO stella_case_law_analysis_reader;--> statement-breakpoint

GRANT SELECT (
  id,
  language,
  polarity,
  pattern,
  match_count,
  source
) ON TABLE "case_law_polarity_rules" TO stella_case_law_analysis_reader;--> statement-breakpoint

GRANT SELECT (country, court_pattern, tier)
  ON TABLE "case_law_court_weights"
  TO stella_case_law_analysis_reader;--> statement-breakpoint

GRANT SELECT (location)
  ON TABLE "case_law_corpus_tombstones"
  TO stella_case_law_analysis_reader;--> statement-breakpoint

CREATE POLICY "case_law_analysis_reader_read" ON "case_law_citations"
  AS PERMISSIVE FOR SELECT TO "stella_case_law_analysis_reader" USING (true);--> statement-breakpoint
CREATE POLICY "case_law_analysis_reader_read" ON "case_law_decisions"
  AS PERMISSIVE FOR SELECT TO "stella_case_law_analysis_reader" USING (true);--> statement-breakpoint
CREATE POLICY "case_law_analysis_reader_read" ON "case_law_polarity_rules"
  AS PERMISSIVE FOR SELECT TO "stella_case_law_analysis_reader" USING (true);--> statement-breakpoint
CREATE POLICY "case_law_analysis_reader_read" ON "case_law_court_weights"
  AS PERMISSIVE FOR SELECT TO "stella_case_law_analysis_reader" USING (true);--> statement-breakpoint
CREATE POLICY "case_law_analysis_reader_read" ON "case_law_corpus_tombstones"
  AS PERMISSIVE FOR SELECT TO "stella_case_law_analysis_reader" USING (true);
