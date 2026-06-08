-- Legislation / statutes corpus — global tables mirroring case law,
-- sharing the object-storage + corpus index substrate via the `legislation`
-- family. Additive. RLS: stella reads, stella_ingestion writes (same
-- global-corpus model as case_law_*; policy names are reused).

CREATE TABLE "legislation_sources" (
  "id" uuid PRIMARY KEY NOT NULL,
  "adapter_key" varchar(64) NOT NULL,
  "name" varchar(256) NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "sync_cursor" text,
  "last_sync_at" timestamp,
  "config" jsonb DEFAULT '{}'::jsonb,
  "descriptor" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legislation_documents" (
  "id" uuid PRIMARY KEY NOT NULL,
  "source_id" uuid NOT NULL,
  "eli" varchar(512) NOT NULL,
  "title" varchar(1024) NOT NULL,
  "country" varchar(3) NOT NULL,
  "language" varchar(8) NOT NULL,
  "document_type" varchar(128),
  "status" varchar(32) DEFAULT 'current' NOT NULL,
  "effective_date" date,
  "version_valid_from" date,
  "version_valid_to" date,
  "fulltext" text,
  "sections" jsonb,
  "document_ast" jsonb,
  "source_url" varchar(2048),
  "document_url" varchar(2048),
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "source_hash" varchar(64),
  "citation_authority" double precision DEFAULT 0 NOT NULL,
  "citation_count" integer DEFAULT 0 NOT NULL,
  "citation_authority_computed_at" timestamp,
  "text_s3_key" varchar(512),
  "normalized_s3_key" varchar(512),
  "ast_s3_key" varchar(512),
  "content_hash" varchar(64),
  "indexed_hash" varchar(64),
  "indexed_generation" varchar(32),
  "indexed_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "legislation_documents_status_values"
    CHECK ("status" IN ('current', 'historical', 'repealed', 'draft'))
);
--> statement-breakpoint
CREATE TABLE "legislation_search_documents" (
  "document_id" uuid PRIMARY KEY NOT NULL,
  "title" text DEFAULT '' NOT NULL,
  "searchable_text" text DEFAULT '' NOT NULL,
  "language" varchar(10),
  "regconfig" varchar(64) DEFAULT 'simple' NOT NULL,
  "tsv" "tsvector",
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legislation_index_jobs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "document_id" uuid,
  "generation" varchar(32) NOT NULL,
  "operation" varchar(16) NOT NULL,
  "status" varchar(16) NOT NULL,
  "content_hash" varchar(64),
  "error_message" varchar(2048),
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "legislation_index_jobs_operation_values"
    CHECK ("operation" IN ('index', 'delete', 'redact', 'rebuild')),
  CONSTRAINT "legislation_index_jobs_status_values"
    CHECK ("status" IN ('succeeded', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "legislation_documents"
  ADD CONSTRAINT "legislation_documents_source_id_legislation_sources_id_fk"
  FOREIGN KEY ("source_id") REFERENCES "legislation_sources"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "legislation_search_documents"
  ADD CONSTRAINT "legislation_search_documents_document_id_legislation_documents_id_fk"
  FOREIGN KEY ("document_id") REFERENCES "legislation_documents"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "legislation_index_jobs"
  ADD CONSTRAINT "legislation_index_jobs_document_id_legislation_documents_id_fk"
  FOREIGN KEY ("document_id") REFERENCES "legislation_documents"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE UNIQUE INDEX "legislation_sources_adapter_key_idx"
  ON "legislation_sources" ("adapter_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "legislation_documents_eli_version_lang_idx"
  ON "legislation_documents" ("source_id", "eli", "version_valid_from", "language");
--> statement-breakpoint
CREATE INDEX "legislation_documents_eli_idx" ON "legislation_documents" ("eli");
--> statement-breakpoint
CREATE INDEX "legislation_documents_country_idx" ON "legislation_documents" ("country");
--> statement-breakpoint
CREATE INDEX "legislation_documents_status_idx" ON "legislation_documents" ("status");
--> statement-breakpoint
CREATE INDEX "legislation_documents_effective_date_idx" ON "legislation_documents" ("effective_date");
--> statement-breakpoint
CREATE INDEX "legislation_documents_created_at_idx" ON "legislation_documents" ("created_at");
--> statement-breakpoint
CREATE INDEX "legislation_documents_citation_authority_idx" ON "legislation_documents" ("citation_authority");
--> statement-breakpoint
CREATE INDEX "legislation_documents_indexed_idx" ON "legislation_documents" ("indexed_hash", "content_hash");
--> statement-breakpoint
CREATE INDEX "legislation_search_docs_tsv_idx" ON "legislation_search_documents" USING gin ("tsv");
--> statement-breakpoint
CREATE INDEX "legislation_index_jobs_document_idx" ON "legislation_index_jobs" ("document_id");
--> statement-breakpoint
CREATE INDEX "legislation_index_jobs_created_idx" ON "legislation_index_jobs" ("created_at");
--> statement-breakpoint
ALTER TABLE "legislation_sources" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "legislation_documents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "legislation_search_documents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "legislation_index_jobs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Global read for stella, full corpus write for stella_ingestion. Policy
-- names match the case-law global-corpus policies (per-table, reused).
CREATE POLICY "case_law_global_access" ON "legislation_sources"
  AS PERMISSIVE FOR SELECT TO "stella" USING (true);
--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "legislation_sources"
  AS PERMISSIVE FOR ALL TO "stella_ingestion" USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "case_law_global_access" ON "legislation_documents"
  AS PERMISSIVE FOR SELECT TO "stella" USING (true);
--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "legislation_documents"
  AS PERMISSIVE FOR ALL TO "stella_ingestion" USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "case_law_global_access" ON "legislation_search_documents"
  AS PERMISSIVE FOR SELECT TO "stella" USING (true);
--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "legislation_search_documents"
  AS PERMISSIVE FOR ALL TO "stella_ingestion" USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "case_law_global_access" ON "legislation_index_jobs"
  AS PERMISSIVE FOR SELECT TO "stella" USING (true);
--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "legislation_index_jobs"
  AS PERMISSIVE FOR ALL TO "stella_ingestion" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- Table grants (RLS gates rows; grants gate access). stella reads only.
GRANT SELECT ON TABLE
  "legislation_sources",
  "legislation_documents",
  "legislation_search_documents",
  "legislation_index_jobs"
TO "stella";
--> statement-breakpoint
GRANT SELECT ON TABLE
  "legislation_sources",
  "legislation_documents",
  "legislation_search_documents",
  "legislation_index_jobs"
TO "stella_ingestion";
--> statement-breakpoint
GRANT INSERT, UPDATE, DELETE ON TABLE
  "legislation_documents",
  "legislation_search_documents"
TO "stella_ingestion";
--> statement-breakpoint
-- Source config is migration-managed; ingestion only advances the cursor.
GRANT UPDATE (sync_cursor, last_sync_at, updated_at)
  ON TABLE "legislation_sources" TO "stella_ingestion";
--> statement-breakpoint
-- Append-only audit trail.
GRANT INSERT ON TABLE "legislation_index_jobs" TO "stella_ingestion";
