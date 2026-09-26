SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Read-only role for internal corpus sampling. It reads a narrow column set of
-- the corpus relations below and holds nothing else.
CREATE ROLE stella_corpus_sample_reader NOLOGIN;--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO stella_corpus_sample_reader;--> statement-breakpoint

GRANT SELECT (
  id,
  citing_decision_id,
  cited_decision_id,
  citation_text,
  section_index,
  polarity,
  kind
) ON TABLE "case_law_citations" TO stella_corpus_sample_reader;--> statement-breakpoint

GRANT SELECT (location)
  ON TABLE "case_law_corpus_tombstones"
  TO stella_corpus_sample_reader;--> statement-breakpoint

GRANT SELECT (
  id,
  case_number,
  ecli,
  court,
  country,
  decision_date,
  decision_type,
  fulltext,
  document_ast,
  source_url,
  document_url,
  metadata,
  redacted_at,
  text_s3_key,
  ast_s3_key
) ON TABLE "case_law_decisions" TO stella_corpus_sample_reader;--> statement-breakpoint

GRANT SELECT (
  id,
  source_id,
  eli,
  title,
  country,
  language,
  document_type,
  status,
  effective_date,
  version_valid_from,
  version_valid_to,
  fulltext,
  source_url,
  document_url,
  metadata,
  text_s3_key
) ON TABLE "legislation_documents" TO stella_corpus_sample_reader;--> statement-breakpoint

GRANT SELECT (id, adapter_key)
  ON TABLE "legislation_sources"
  TO stella_corpus_sample_reader;--> statement-breakpoint

CREATE POLICY "corpus_sample_reader_read" ON "case_law_citations"
  AS PERMISSIVE FOR SELECT TO "stella_corpus_sample_reader" USING (true);--> statement-breakpoint
CREATE POLICY "corpus_sample_reader_read" ON "case_law_corpus_tombstones"
  AS PERMISSIVE FOR SELECT TO "stella_corpus_sample_reader" USING (true);--> statement-breakpoint
-- Redacted decisions stay invisible even while a failed object deletion leaves
-- their storage keys set for retry.
CREATE POLICY "corpus_sample_reader_read" ON "case_law_decisions"
  AS PERMISSIVE FOR SELECT TO "stella_corpus_sample_reader"
  USING (redacted_at IS NULL);--> statement-breakpoint
CREATE POLICY "corpus_sample_reader_read" ON "legislation_documents"
  AS PERMISSIVE FOR SELECT TO "stella_corpus_sample_reader" USING (true);--> statement-breakpoint
CREATE POLICY "corpus_sample_reader_read" ON "legislation_sources"
  AS PERMISSIVE FOR SELECT TO "stella_corpus_sample_reader" USING (true);
