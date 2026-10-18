SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

-- Existing connectors retain window identity. New sources select publisher
-- identity when registered; this migration does not transition stored corpora.
ALTER TABLE "legislation_sources" ADD COLUMN IF NOT EXISTS "identity_mode" varchar(32) DEFAULT 'legacy-window' NOT NULL;--> statement-breakpoint
ALTER TABLE "legislation_documents" ADD COLUMN IF NOT EXISTS "identity_mode" varchar(32) DEFAULT 'legacy-window' NOT NULL;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "guard_legislation_source_identity_mode"()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.identity_mode IS DISTINCT FROM OLD.identity_mode THEN
    RAISE EXCEPTION 'legislation source identity mode is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreates only this migration's guard on retry.
DROP TRIGGER IF EXISTS "legislation_sources_identity_mode_guard" ON "legislation_sources";--> statement-breakpoint
CREATE TRIGGER "legislation_sources_identity_mode_guard" BEFORE UPDATE OF "identity_mode" ON "legislation_sources"
FOR EACH ROW EXECUTE FUNCTION "guard_legislation_source_identity_mode"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "derive_legislation_document_identity_mode"()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  SELECT identity_mode INTO NEW.identity_mode FROM legislation_sources WHERE id = NEW.source_id;
  IF NEW.identity_mode IS NULL THEN
    RAISE EXCEPTION 'legislation document source is missing' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW.identity_mode = 'publisher-expression' AND NEW.publisher_expression_id IS NULL THEN
    RAISE EXCEPTION 'publisher-identity source requires an expression id' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreates only this migration's guard on retry.
DROP TRIGGER IF EXISTS "legislation_documents_derive_identity_mode" ON "legislation_documents";--> statement-breakpoint
CREATE TRIGGER "legislation_documents_derive_identity_mode" BEFORE INSERT OR UPDATE OF "source_id", "identity_mode", "publisher_expression_id" ON "legislation_documents"
FOR EACH ROW EXECUTE FUNCTION "derive_legislation_document_identity_mode"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "guard_legislation_publisher_writer"()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF (NEW.identity_mode = 'publisher-expression'
      OR (TG_OP = 'UPDATE' AND OLD.identity_mode = 'publisher-expression'))
     AND current_setting('stella.legislation_writer_contract', true) IS DISTINCT FROM 'expression-v2' THEN
    RAISE EXCEPTION 'publisher-identity source requires the current legislation writer' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
-- Runs after identity derivation (Postgres orders same-kind triggers by name).
-- stella-migration-safety: reviewed drop-object - Recreates only this migration's writer fence on retry.
DROP TRIGGER IF EXISTS "legislation_documents_publisher_writer_guard" ON "legislation_documents";--> statement-breakpoint
CREATE TRIGGER "legislation_documents_publisher_writer_guard" BEFORE INSERT OR UPDATE OF "source_hash", "source_id", "identity_mode", "publisher_expression_id" ON "legislation_documents"
FOR EACH ROW EXECUTE FUNCTION "guard_legislation_publisher_writer"();--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - Replaces only this migration's CHECK on retry.
ALTER TABLE "legislation_sources" DROP CONSTRAINT IF EXISTS "legislation_sources_identity_mode_values";--> statement-breakpoint
ALTER TABLE "legislation_sources" ADD CONSTRAINT "legislation_sources_identity_mode_values" CHECK (identity_mode IN ('legacy-window','publisher-expression')) NOT VALID;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - Replaces only this migration's CHECK on retry.
ALTER TABLE "legislation_sources" DROP CONSTRAINT IF EXISTS "legislation_sources_publisher_namespace";--> statement-breakpoint
ALTER TABLE "legislation_sources" ADD CONSTRAINT "legislation_sources_publisher_namespace" CHECK (identity_mode <> 'publisher-expression' OR expression_namespace IS NOT NULL) NOT VALID;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - Replaces only this migration's CHECK on retry.
ALTER TABLE "legislation_documents" DROP CONSTRAINT IF EXISTS "legislation_documents_identity_mode_values";--> statement-breakpoint
ALTER TABLE "legislation_documents" ADD CONSTRAINT "legislation_documents_identity_mode_values" CHECK (identity_mode IN ('legacy-window','publisher-expression')) NOT VALID;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - Replaces only this migration's CHECK on retry.
ALTER TABLE "legislation_documents" DROP CONSTRAINT IF EXISTS "legislation_documents_publisher_identity_required";--> statement-breakpoint
ALTER TABLE "legislation_documents" ADD CONSTRAINT "legislation_documents_publisher_identity_required" CHECK (identity_mode <> 'publisher-expression' OR publisher_expression_id IS NOT NULL) NOT VALID;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - Adds an explicit unknown lifecycle while retaining all existing statuses.
ALTER TABLE "legislation_documents" DROP CONSTRAINT IF EXISTS "legislation_documents_status_values";--> statement-breakpoint
ALTER TABLE "legislation_documents" ADD CONSTRAINT "legislation_documents_status_values" CHECK (status IN ('current','historical','repealed','draft','unknown')) NOT VALID;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "legislation_work_identifiers" (
  source_id uuid NOT NULL,
  identifier varchar(512) NOT NULL,
  eli varchar(512) NOT NULL,
  PRIMARY KEY (source_id, identifier)
);--> statement-breakpoint
ALTER TABLE "legislation_work_identifiers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legislation_work_identifiers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreates only this migration's policy on retry.
DROP POLICY IF EXISTS "legislation_work_identifier_owner_access" ON "legislation_work_identifiers";--> statement-breakpoint
-- stella-migration-safety: reviewed permissive-policy - Forced RLS owner access; the request role has no table privileges.
CREATE POLICY "legislation_work_identifier_owner_access" ON "legislation_work_identifiers" AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreates only this migration's policy on retry.
DROP POLICY IF EXISTS "case_law_ingestion_access" ON "legislation_work_identifiers";--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "legislation_work_identifiers" AS PERMISSIVE FOR ALL TO stella_ingestion USING (true) WITH CHECK (true);--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Recreates only this migration's policy on retry.
DROP POLICY IF EXISTS "public_law_reader_access" ON "legislation_work_identifiers";--> statement-breakpoint
CREATE POLICY "public_law_reader_access" ON "legislation_work_identifiers" AS PERMISSIVE FOR SELECT TO stella_public_law_reader USING (true);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "legislation_work_identifiers" FROM stella;--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE "legislation_work_identifiers" TO stella_ingestion;--> statement-breakpoint
GRANT SELECT (source_id,identifier,eli) ON TABLE "legislation_work_identifiers" TO stella_public_law_reader;--> statement-breakpoint

-- Release additive DDL locks before online index scans. Every preceding
-- operation tolerates replay, including replacement of this migration's policies.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "legislation_documents_work_version_lang_idx" ON "legislation_documents" (source_id,eli,version_valid_from,language) WHERE version_valid_from IS NOT NULL;
--> statement-breakpoint
REINDEX INDEX CONCURRENTLY "legislation_documents_work_version_lang_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "legislation_documents_publisher_identity_idx" ON "legislation_documents" (source_id,eli,language,publisher_expression_id) WHERE identity_mode = 'publisher-expression';
--> statement-breakpoint
REINDEX INDEX CONCURRENTLY "legislation_documents_publisher_identity_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "legislation_documents_legacy_version_lang_idx" ON "legislation_documents" (source_id,eli,version_valid_from,language) WHERE identity_mode = 'legacy-window' AND version_valid_from IS NOT NULL;
--> statement-breakpoint
REINDEX INDEX CONCURRENTLY "legislation_documents_legacy_version_lang_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "legislation_documents_legacy_current_lang_idx" ON "legislation_documents" (source_id,eli,language) WHERE identity_mode = 'legacy-window' AND version_valid_from IS NULL;
--> statement-breakpoint
REINDEX INDEX CONCURRENTLY "legislation_documents_legacy_current_lang_idx";
--> statement-breakpoint
-- The online migration owner proves all replacements ready before retiring
-- the two global date keys. Keep the old keys until that postcondition holds.
SET statement_timeout = '10s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legislation_work_identifiers_identifier_idx" ON "legislation_work_identifiers" (identifier,source_id,eli);
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - Recreates only this migration's source foreign key on retry.
ALTER TABLE "legislation_work_identifiers" DROP CONSTRAINT IF EXISTS "legislation_work_identifiers_source_fk";
--> statement-breakpoint
ALTER TABLE "legislation_work_identifiers" ADD CONSTRAINT "legislation_work_identifiers_source_fk" FOREIGN KEY (source_id) REFERENCES legislation_sources(id) ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - Recreates only this migration's nonempty identifier CHECK on retry.
ALTER TABLE "legislation_work_identifiers" DROP CONSTRAINT IF EXISTS "legislation_work_identifiers_nonempty";
--> statement-breakpoint
ALTER TABLE "legislation_work_identifiers" ADD CONSTRAINT "legislation_work_identifiers_nonempty" CHECK (length(identifier) > 0 AND length(eli) > 0) NOT VALID;
--> statement-breakpoint
SET statement_timeout = '10min';
--> statement-breakpoint
ALTER TABLE "legislation_work_identifiers" VALIDATE CONSTRAINT "legislation_work_identifiers_source_fk";
--> statement-breakpoint
ALTER TABLE "legislation_work_identifiers" VALIDATE CONSTRAINT "legislation_work_identifiers_nonempty";
--> statement-breakpoint
ALTER TABLE "legislation_sources" VALIDATE CONSTRAINT "legislation_sources_identity_mode_values";
--> statement-breakpoint
ALTER TABLE "legislation_sources" VALIDATE CONSTRAINT "legislation_sources_publisher_namespace";
--> statement-breakpoint
ALTER TABLE "legislation_documents" VALIDATE CONSTRAINT "legislation_documents_identity_mode_values";
--> statement-breakpoint
ALTER TABLE "legislation_documents" VALIDATE CONSTRAINT "legislation_documents_publisher_identity_required";
--> statement-breakpoint
ALTER TABLE "legislation_documents" VALIDATE CONSTRAINT "legislation_documents_status_values";
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
