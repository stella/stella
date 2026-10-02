SET lock_timeout = '1s';
SET statement_timeout = '10s';
--> statement-breakpoint
CREATE TABLE "soft_law_document_locators" (
	"id" uuid PRIMARY KEY,
	"document_id" uuid NOT NULL,
	"url" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "soft_law_locators_url_unique" UNIQUE("document_id","url")
);

--> statement-breakpoint
ALTER TABLE "soft_law_document_locators" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "soft_law_document_versions" (
	"id" uuid PRIMARY KEY,
	"document_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"content_hash" text NOT NULL,
	"raw_objects" jsonb NOT NULL,
	"metadata" jsonb NOT NULL,
	"extracted_text" text,
	"extraction_quality" text NOT NULL,
	"source_dates" jsonb NOT NULL,
	"observed_from" timestamp with time zone NOT NULL,
	"observed_to" timestamp with time zone,
	CONSTRAINT "soft_law_versions_sequence_unique" UNIQUE("document_id","sequence"),
	CONSTRAINT "soft_law_versions_quality_check" CHECK ("extraction_quality" IN ('html','text_layer','needs_ocr','scanned_ocr','extraction_failed')),
	CONSTRAINT "soft_law_versions_sequence_check" CHECK ("sequence" > 0),
	CONSTRAINT "soft_law_versions_window_check" CHECK ("observed_to" IS NULL OR "observed_to" >= "observed_from")
);

--> statement-breakpoint
ALTER TABLE "soft_law_document_versions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "soft_law_documents" (
	"id" uuid PRIMARY KEY,
	"source_id" uuid NOT NULL,
	"identity_key" text NOT NULL,
	"jurisdiction" text NOT NULL,
	"authority" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"stated_reference" text,
	"stated_reference_state" text NOT NULL,
	"issued_on" date,
	"issued_on_state" text NOT NULL,
	"listing_state" text NOT NULL,
	"validity_state" text NOT NULL,
	"validity_basis" text NOT NULL,
	"superseded_by" uuid,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"last_seen_run" uuid NOT NULL,
	CONSTRAINT "soft_law_documents_identity_unique" UNIQUE("source_id","identity_key"),
	CONSTRAINT "soft_law_documents_kind_check" CHECK ("kind" IN ('methodology','recommendation','opinion','faq','guideline','position','inspection_report','annual_report','other')),
	CONSTRAINT "soft_law_documents_listing_check" CHECK ("listing_state" IN ('listed','no_longer_listed')),
	CONSTRAINT "soft_law_documents_validity_check" CHECK ("validity_state" IN ('not_stated','withdrawn','superseded','historical_repealed_basis') AND "validity_basis" IN ('source_stated','archived_source_stated') AND ("superseded_by" IS NULL OR "validity_state" = 'superseded')),
	CONSTRAINT "soft_law_documents_reference_check" CHECK (("stated_reference_state" = 'stated' AND "stated_reference" IS NOT NULL AND length(btrim("stated_reference")) > 0) OR ("stated_reference_state" = 'not_stated' AND "stated_reference" IS NULL)),
	CONSTRAINT "soft_law_documents_issued_check" CHECK (("issued_on_state" = 'stated' AND "issued_on" IS NOT NULL) OR ("issued_on_state" = 'not_stated' AND "issued_on" IS NULL))
);

--> statement-breakpoint
ALTER TABLE "soft_law_documents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "soft_law_sources" (
	"id" uuid PRIMARY KEY,
	"adapter_key" text NOT NULL UNIQUE,
	"descriptor" jsonb NOT NULL,
	"sync_cursor" text,
	"last_sync_at" timestamp with time zone,
	"run_state" text DEFAULT 'idle' NOT NULL,
	"run_id" uuid,
	"run_started_at" timestamp with time zone,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"failure_tag" text,
	CONSTRAINT "soft_law_sources_state_check" CHECK ("run_state" IN ('idle','running','blocked','failed')),
	CONSTRAINT "soft_law_sources_run_check" CHECK (("run_state" = 'idle' AND "run_id" IS NULL AND "run_started_at" IS NULL AND "sync_cursor" IS NULL) OR ("run_state" <> 'idle' AND "run_id" IS NOT NULL AND "run_started_at" IS NOT NULL)),
	CONSTRAINT "soft_law_sources_lease_check" CHECK (("lease_token" IS NULL AND "lease_expires_at" IS NULL) OR ("run_state" = 'running' AND "lease_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL))
);

--> statement-breakpoint
ALTER TABLE "soft_law_sources" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE UNIQUE INDEX "soft_law_versions_open_unique" ON "soft_law_document_versions" ("document_id") WHERE "observed_to" IS NULL;
--> statement-breakpoint
CREATE INDEX "soft_law_documents_run_idx" ON "soft_law_documents" ("source_id","last_seen_run");
--> statement-breakpoint
ALTER TABLE "soft_law_document_locators" ADD CONSTRAINT "soft_law_document_locators_tunJo2R6ktOy_fkey" FOREIGN KEY ("document_id") REFERENCES "soft_law_documents"("id");
--> statement-breakpoint
ALTER TABLE "soft_law_document_versions" ADD CONSTRAINT "soft_law_document_versions_sPgCvYAiUjFy_fkey" FOREIGN KEY ("document_id") REFERENCES "soft_law_documents"("id");
--> statement-breakpoint
ALTER TABLE "soft_law_documents" ADD CONSTRAINT "soft_law_documents_source_id_soft_law_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "soft_law_sources"("id");
--> statement-breakpoint
ALTER TABLE "soft_law_documents" ADD CONSTRAINT "soft_law_documents_superseded_by_fk" FOREIGN KEY ("superseded_by") REFERENCES "soft_law_documents"("id");
--> statement-breakpoint
CREATE POLICY "soft_law_owner_access" ON "soft_law_document_locators" AS PERMISSIVE FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.soft_law_document_locators'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.soft_law_document_locators'::regclass));
--> statement-breakpoint
CREATE POLICY "soft_law_owner_access" ON "soft_law_document_versions" AS PERMISSIVE FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.soft_law_document_versions'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.soft_law_document_versions'::regclass));
--> statement-breakpoint
CREATE POLICY "soft_law_owner_access" ON "soft_law_documents" AS PERMISSIVE FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.soft_law_documents'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.soft_law_documents'::regclass));
--> statement-breakpoint
CREATE POLICY "soft_law_owner_access" ON "soft_law_sources" AS PERMISSIVE FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.soft_law_sources'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.soft_law_sources'::regclass));
--> statement-breakpoint
ALTER TABLE "soft_law_document_locators" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "soft_law_document_versions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "soft_law_documents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "soft_law_sources" FORCE ROW LEVEL SECURITY;

--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "soft_law_sources", "soft_law_documents", "soft_law_document_versions", "soft_law_document_locators" FROM stella;

--> statement-breakpoint
CREATE INDEX "soft_law_locators_url_idx" ON "soft_law_document_locators" ("url");
