SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Add the shared role beside stella_caselaw_reader. The older role must keep
-- its exact grants until the v0.7.22 rollback window has closed; older local
-- readers validate that boundary at connection time.
CREATE ROLE stella_public_law_reader NOLOGIN;--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO stella_public_law_reader;--> statement-breakpoint

GRANT SELECT (
  id,
  citing_decision_id,
  cited_decision_id,
  citation_text,
  kind,
  section_index,
  polarity
) ON TABLE "case_law_citations" TO stella_public_law_reader;--> statement-breakpoint

GRANT SELECT (
  generation,
  decision_id,
  index_id,
  indexed_hash,
  pending_action
) ON TABLE "case_law_corpus_index_projections" TO stella_public_law_reader;--> statement-breakpoint

GRANT SELECT (
  id,
  source_id,
  case_number,
  slug,
  ecli,
  court,
  country,
  language,
  language_group_key,
  decision_date,
  decision_type,
  fulltext,
  document_ast,
  analysis,
  source_url,
  document_url,
  metadata,
  redacted_at,
  citation_authority,
  citation_count,
  text_s3_key,
  ast_s3_key,
  content_hash,
  indexed_hash,
  created_at,
  updated_at
) ON TABLE "case_law_decisions" TO stella_public_law_reader;--> statement-breakpoint

GRANT SELECT (
  decision_id,
  jurisdiction,
  work_identifier,
  work_number,
  work_year,
  work_collection,
  work_eli,
  unit,
  section,
  section_suffix,
  subsection,
  letter,
  point,
  sentence,
  open_ended,
  anchor,
  version_valid_from,
  decision_date,
  sentence_text,
  span_start,
  span_end,
  work_source,
  confidence
) ON TABLE "case_law_provision_citations" TO stella_public_law_reader;--> statement-breakpoint

GRANT SELECT (id, name, adapter_key, descriptor)
  ON TABLE "case_law_sources"
  TO stella_public_law_reader;--> statement-breakpoint

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
  sections,
  document_ast,
  source_url,
  document_url,
  citation_authority,
  text_s3_key,
  ast_s3_key,
  content_hash,
  indexed_hash,
  created_at,
  updated_at
) ON TABLE "legislation_documents" TO stella_public_law_reader;--> statement-breakpoint

GRANT SELECT (id, descriptor)
  ON TABLE "legislation_sources"
  TO stella_public_law_reader;--> statement-breakpoint

CREATE POLICY "public_law_reader_access" ON "case_law_citations"
  AS PERMISSIVE FOR SELECT TO "stella_public_law_reader" USING (true);--> statement-breakpoint
CREATE POLICY "public_law_reader_access" ON "case_law_corpus_index_projections"
  AS PERMISSIVE FOR SELECT TO "stella_public_law_reader" USING (true);--> statement-breakpoint
CREATE POLICY "public_law_reader_access" ON "case_law_decisions"
  AS PERMISSIVE FOR SELECT TO "stella_public_law_reader" USING (true);--> statement-breakpoint
CREATE POLICY "public_law_reader_access" ON "case_law_provision_citations"
  AS PERMISSIVE FOR SELECT TO "stella_public_law_reader" USING (true);--> statement-breakpoint
CREATE POLICY "public_law_reader_access" ON "case_law_sources"
  AS PERMISSIVE FOR SELECT TO "stella_public_law_reader" USING (true);--> statement-breakpoint

CREATE POLICY "public_law_reader_access" ON "legislation_documents"
  AS PERMISSIVE FOR SELECT TO "stella_public_law_reader" USING (true);--> statement-breakpoint
CREATE POLICY "public_law_reader_access" ON "legislation_sources"
  AS PERMISSIVE FOR SELECT TO "stella_public_law_reader" USING (true);
