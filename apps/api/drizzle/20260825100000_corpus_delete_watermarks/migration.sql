SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Quickwit deletions are asynchronous. These constant-size high-water marks
-- retain the task identity returned by the engine, so settlement checks never
-- need to scan its append-only delete-task history.
CREATE TABLE "case_law_corpus_index_delete_watermarks" (
  "index_id" varchar(64) PRIMARY KEY,
  "opstamp" bigint NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "case_law_corpus_index_delete_watermarks_nonnegative"
    CHECK ("opstamp" >= 0)
);--> statement-breakpoint

ALTER TABLE "case_law_corpus_index_delete_watermarks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access"
  ON "case_law_corpus_index_delete_watermarks"
  AS PERMISSIVE FOR ALL TO stella_ingestion
  USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "case_law_global_access"
  ON "case_law_corpus_index_delete_watermarks"
  AS PERMISSIVE FOR SELECT TO stella
  USING (true);--> statement-breakpoint
GRANT SELECT ON TABLE "case_law_corpus_index_delete_watermarks" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE
  ON TABLE "case_law_corpus_index_delete_watermarks" TO stella_ingestion;--> statement-breakpoint

CREATE TABLE "legislation_corpus_index_delete_watermarks" (
  "index_id" varchar(64) PRIMARY KEY,
  "opstamp" bigint NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "legislation_corpus_index_delete_watermarks_nonnegative"
    CHECK ("opstamp" >= 0)
);--> statement-breakpoint

ALTER TABLE "legislation_corpus_index_delete_watermarks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access"
  ON "legislation_corpus_index_delete_watermarks"
  AS PERMISSIVE FOR ALL TO stella_ingestion
  USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "case_law_global_access"
  ON "legislation_corpus_index_delete_watermarks"
  AS PERMISSIVE FOR SELECT TO stella
  USING (true);--> statement-breakpoint
GRANT SELECT ON TABLE "legislation_corpus_index_delete_watermarks" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE
  ON TABLE "legislation_corpus_index_delete_watermarks" TO stella_ingestion;
