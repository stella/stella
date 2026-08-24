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

CREATE TABLE "case_law_corpus_index_pending_deletes" (
  "index_id" varchar(64) NOT NULL,
  "decision_id" uuid NOT NULL,
  "opstamp" bigint NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "case_law_corpus_index_pending_deletes_pkey"
    PRIMARY KEY ("index_id", "decision_id"),
  CONSTRAINT "case_law_corpus_index_pending_deletes_nonnegative"
    CHECK ("opstamp" >= 0)
);--> statement-breakpoint

CREATE INDEX "case_law_corpus_index_pending_deletes_settlement_idx"
  ON "case_law_corpus_index_pending_deletes" ("index_id", "opstamp");--> statement-breakpoint
ALTER TABLE "case_law_corpus_index_pending_deletes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access"
  ON "case_law_corpus_index_pending_deletes"
  AS PERMISSIVE FOR ALL TO stella_ingestion
  USING (true) WITH CHECK (true);--> statement-breakpoint
REVOKE ALL PRIVILEGES
  ON TABLE "case_law_corpus_index_pending_deletes" FROM stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "case_law_corpus_index_pending_deletes" TO stella_ingestion;--> statement-breakpoint

CREATE TABLE "legislation_corpus_index_delete_watermarks" (
  "index_id" varchar(64) PRIMARY KEY,
  "opstamp" bigint NOT NULL,
  "last_checked_at" timestamptz,
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
CREATE INDEX "legislation_corpus_index_delete_watermarks_check_idx"
  ON "legislation_corpus_index_delete_watermarks" ("last_checked_at");--> statement-breakpoint

CREATE TABLE "legislation_corpus_index_pending_deletes" (
  "index_id" varchar(64) NOT NULL,
  "document_id" uuid NOT NULL,
  "opstamp" bigint NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "legislation_corpus_index_pending_deletes_pkey"
    PRIMARY KEY ("index_id", "document_id"),
  CONSTRAINT "legislation_corpus_index_pending_deletes_nonnegative"
    CHECK ("opstamp" >= 0)
);--> statement-breakpoint

CREATE INDEX "legislation_corpus_index_pending_deletes_settlement_idx"
  ON "legislation_corpus_index_pending_deletes" ("index_id", "opstamp");--> statement-breakpoint
ALTER TABLE "legislation_corpus_index_pending_deletes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access"
  ON "legislation_corpus_index_pending_deletes"
  AS PERMISSIVE FOR ALL TO stella_ingestion
  USING (true) WITH CHECK (true);--> statement-breakpoint
REVOKE ALL PRIVILEGES
  ON TABLE "legislation_corpus_index_pending_deletes" FROM stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "legislation_corpus_index_pending_deletes" TO stella_ingestion;
