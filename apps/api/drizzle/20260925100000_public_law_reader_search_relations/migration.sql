SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The public search paths match and rank on the search documents, parse a
-- query with the language's text-search configuration, and rank courts from
-- the court registry. Give the constrained reader exactly the columns those
-- reads name. Indexer bookkeeping (stored titles, preview generations,
-- refresh times) and the registry's row ids stay ungranted.
GRANT SELECT (decision_id, language, regconfig, tsv, searchable_text)
  ON TABLE "case_law_search_documents"
  TO stella_public_law_reader;--> statement-breakpoint

GRANT SELECT (country, court_pattern, tier, tier_label, weight)
  ON TABLE "case_law_court_weights"
  TO stella_public_law_reader;--> statement-breakpoint

GRANT SELECT (language, regconfig, use_unaccent)
  ON TABLE "case_law_fts_configs"
  TO stella_public_law_reader;--> statement-breakpoint

-- `retry_after` is the eligibility a legislation search filters on.
GRANT SELECT (document_id, language, regconfig, tsv, searchable_text, retry_after)
  ON TABLE "legislation_search_documents"
  TO stella_public_law_reader;--> statement-breakpoint

CREATE POLICY "public_law_reader_access" ON "case_law_search_documents"
  AS PERMISSIVE FOR SELECT TO "stella_public_law_reader" USING (true);--> statement-breakpoint
CREATE POLICY "public_law_reader_access" ON "case_law_court_weights"
  AS PERMISSIVE FOR SELECT TO "stella_public_law_reader" USING (true);--> statement-breakpoint
CREATE POLICY "public_law_reader_access" ON "case_law_fts_configs"
  AS PERMISSIVE FOR SELECT TO "stella_public_law_reader" USING (true);--> statement-breakpoint
CREATE POLICY "public_law_reader_access" ON "legislation_search_documents"
  AS PERMISSIVE FOR SELECT TO "stella_public_law_reader" USING (true);
