-- Legal corpus + corpus index migration.
--
-- Additive only. The pg-fts path (case_law_decisions.fulltext /
-- sections / document_ast and the case_law_search_documents tsvector
-- table) is left intact and remains the canonical text + search backend
-- until the corpus index cutover is proven. Those columns/tables are dropped
-- only in a later, separately-acknowledged release.

-- Bound lock waits and runtime for the whole wrapping transaction.
set lock_timeout = '10s';
--> statement-breakpoint
set statement_timeout = '10min';
--> statement-breakpoint

-- 1. Per-source license / redistribution descriptor (see corpus-source.ts).
ALTER TABLE "case_law_sources"
  ADD COLUMN "descriptor" jsonb;
--> statement-breakpoint

-- 2. Decision corpus + indexing bookkeeping columns.
ALTER TABLE "case_law_decisions"
  ADD COLUMN "citation_authority" double precision DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "case_law_decisions"
  ADD COLUMN "citation_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "case_law_decisions"
  ADD COLUMN "citation_authority_computed_at" timestamp;
--> statement-breakpoint
ALTER TABLE "case_law_decisions"
  ADD COLUMN "text_s3_key" varchar(512);
--> statement-breakpoint
ALTER TABLE "case_law_decisions"
  ADD COLUMN "normalized_s3_key" varchar(512);
--> statement-breakpoint
ALTER TABLE "case_law_decisions"
  ADD COLUMN "ast_s3_key" varchar(512);
--> statement-breakpoint
ALTER TABLE "case_law_decisions"
  ADD COLUMN "content_hash" varchar(64);
--> statement-breakpoint
ALTER TABLE "case_law_decisions"
  ADD COLUMN "indexed_hash" varchar(64);
--> statement-breakpoint
ALTER TABLE "case_law_decisions"
  ADD COLUMN "indexed_generation" varchar(32);
--> statement-breakpoint
ALTER TABLE "case_law_decisions"
  ADD COLUMN "indexed_at" timestamp;
--> statement-breakpoint
-- The only writer to case_law_decisions is the background ingestion
-- daemon; blocking its writes for the index build is acceptable and
-- reads stay available, so CONCURRENTLY (which would require splitting
-- the wrapping transaction) is not needed.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "case_law_decisions_citation_authority_idx"
  ON "case_law_decisions" ("citation_authority");
--> statement-breakpoint
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "case_law_decisions_indexed_idx"
  ON "case_law_decisions" ("indexed_hash", "content_hash");
--> statement-breakpoint

-- 3. Append-only audit trail for index mutations across the
--    object-store + corpus index boundary.
CREATE TABLE "case_law_index_jobs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "decision_id" uuid,
  "generation" varchar(32) NOT NULL,
  "operation" varchar(16) NOT NULL,
  "status" varchar(16) NOT NULL,
  "content_hash" varchar(64),
  "error_message" varchar(2048),
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "case_law_index_jobs_operation_values"
    CHECK ("operation" IN ('index', 'delete', 'redact', 'rebuild')),
  CONSTRAINT "case_law_index_jobs_status_values"
    CHECK ("status" IN ('succeeded', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "case_law_index_jobs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "case_law_index_jobs"
  ADD CONSTRAINT "case_law_index_jobs_decision_id_case_law_decisions_id_fk"
  FOREIGN KEY ("decision_id") REFERENCES "case_law_decisions"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX "case_law_index_jobs_decision_idx"
  ON "case_law_index_jobs" ("decision_id");
--> statement-breakpoint
CREATE INDEX "case_law_index_jobs_created_idx"
  ON "case_law_index_jobs" ("created_at");
--> statement-breakpoint
CREATE POLICY "case_law_global_access" ON "case_law_index_jobs"
  AS PERMISSIVE FOR SELECT TO "stella"
  USING (true);
--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "case_law_index_jobs"
  AS PERMISSIVE FOR ALL TO "stella_ingestion"
  USING (true) WITH CHECK (true);
--> statement-breakpoint
-- RLS policies gate rows; table GRANTs gate access. The audit table is
-- append-only for the ingestion daemon: SELECT + INSERT, no UPDATE/DELETE.
GRANT SELECT ON TABLE "case_law_index_jobs" TO "stella";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "case_law_index_jobs" TO "stella_ingestion";
