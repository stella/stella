-- requires: 20261004104100_soft_law_corpus
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint

-- A sync registers its source row on first run; the ingestion role held only
-- UPDATE on run-state columns, so registration could not succeed. Table-level:
-- the ORM names every column in an INSERT, spelling unset ones as DEFAULT.
GRANT INSERT ON TABLE "soft_law_sources" TO stella_ingestion;--> statement-breakpoint

-- The same transaction records the registration in the system audit, which the
-- ingestion role could not write either.
GRANT INSERT ON TABLE "system_audit_runs" TO stella_ingestion;--> statement-breakpoint

CREATE POLICY "system_audit_runs_ingestion_insert" ON "system_audit_runs"
  AS PERMISSIVE FOR INSERT TO "stella_ingestion" WITH CHECK (true);--> statement-breakpoint

-- The reader gets the columns a served document shows and nothing operational:
-- raw publisher payloads, identity keys, run ids and leases stay with ingestion.
GRANT SELECT (
  id,
  jurisdiction,
  authority,
  kind,
  title,
  stated_reference,
  issued_on,
  listing_state,
  validity_state,
  validity_basis
) ON TABLE "soft_law_documents" TO stella_public_law_reader;--> statement-breakpoint

GRANT SELECT (
  document_id,
  metadata,
  extracted_text,
  extraction_quality,
  observed_to
) ON TABLE "soft_law_document_versions" TO stella_public_law_reader;--> statement-breakpoint

GRANT SELECT (
  document_id,
  url,
  state,
  last_seen_at
) ON TABLE "soft_law_document_locators" TO stella_public_law_reader;--> statement-breakpoint

-- Row security is forced on these tables, so a grant without a policy reads
-- as an empty table. Which sources are served is decided by the read path.
CREATE POLICY "public_law_reader_access" ON "soft_law_documents"
  AS PERMISSIVE FOR SELECT TO "stella_public_law_reader" USING (true);--> statement-breakpoint

CREATE POLICY "public_law_reader_access" ON "soft_law_document_versions"
  AS PERMISSIVE FOR SELECT TO "stella_public_law_reader" USING (true);--> statement-breakpoint

CREATE POLICY "public_law_reader_access" ON "soft_law_document_locators"
  AS PERMISSIVE FOR SELECT TO "stella_public_law_reader" USING (true);
