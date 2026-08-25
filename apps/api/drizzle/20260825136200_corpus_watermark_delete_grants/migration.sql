SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Corpus generation retirement removes settlement state only after the
-- corresponding engine index is gone. The ingestion policies already admit
-- DELETE; complete the table privilege needed for that operation.
GRANT DELETE
  ON TABLE "case_law_corpus_index_delete_watermarks" TO stella_ingestion;--> statement-breakpoint
GRANT DELETE
  ON TABLE "legislation_corpus_index_delete_watermarks" TO stella_ingestion;
