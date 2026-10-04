SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Pagination needs the applied revision's physical passage count to distinguish
-- singleton documents from documents that can recur in a later scan window.
GRANT SELECT (applied_revision)
  ON TABLE "corpus_index_projection_states"
  TO stella_public_law_reader;--> statement-breakpoint

GRANT SELECT (id, expected_document_count)
  ON TABLE "corpus_index_projection_intents"
  TO stella_public_law_reader;--> statement-breakpoint

CREATE POLICY "public_law_reader_access" ON "corpus_index_projection_intents"
  AS PERMISSIVE FOR SELECT TO "stella_public_law_reader" USING (true);
