SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A durable tombstone prevents ingestion and deferred-document workers from
-- implicitly restoring payloads after a redaction.
ALTER TABLE "case_law_decisions"
  ADD COLUMN IF NOT EXISTS "redacted_at" timestamptz;--> statement-breakpoint

-- Old rollout tasks cannot name redacted_at. Fence their payload scrub in the
-- database so the tombstone lands in the same statement, before a new reader
-- can observe an erased-but-refetchable row.
CREATE OR REPLACE FUNCTION fence_legacy_case_law_redaction()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.redacted_at IS NULL
    AND NEW.fulltext IS NULL
    AND NEW.sections IS NULL
    AND NEW.document_ast IS NULL
    AND NEW.content_hash IS NULL
    AND (
      OLD.fulltext IS NOT NULL
      OR OLD.sections IS NOT NULL
      OR OLD.document_ast IS NOT NULL
      OR OLD.content_hash IS NOT NULL
    )
  THEN
    NEW.redacted_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$function$;--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - replaces only this migration's compatibility trigger; table data is unchanged.
DROP TRIGGER IF EXISTS case_law_decisions_legacy_redaction_fence
  ON "case_law_decisions";--> statement-breakpoint
CREATE TRIGGER case_law_decisions_legacy_redaction_fence
BEFORE UPDATE OF fulltext, sections, document_ast, content_hash
ON "case_law_decisions"
FOR EACH ROW
EXECUTE FUNCTION fence_legacy_case_law_redaction();--> statement-breakpoint

-- A metadata-only decision has no payload transition for the fence above to
-- observe. Its append-only redaction audit closes that compatibility case.
CREATE OR REPLACE FUNCTION tombstone_legacy_case_law_redaction_audit()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.operation = 'redact' AND NEW.decision_id IS NOT NULL THEN
    UPDATE "case_law_decisions"
    SET "redacted_at" = COALESCE("redacted_at", NEW.created_at)
    WHERE "id" = NEW.decision_id
      AND "redacted_at" IS NULL
      AND "fulltext" IS NULL
      AND "sections" IS NULL
      AND "document_ast" IS NULL
      AND "content_hash" IS NULL;
  END IF;
  RETURN NEW;
END
$function$;--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - replaces only this migration's compatibility trigger; append-only audit data is unchanged.
DROP TRIGGER IF EXISTS case_law_index_jobs_legacy_redaction_tombstone
  ON "case_law_index_jobs";--> statement-breakpoint
CREATE TRIGGER case_law_index_jobs_legacy_redaction_tombstone
AFTER INSERT ON "case_law_index_jobs"
FOR EACH ROW
EXECUTE FUNCTION tombstone_legacy_case_law_redaction_audit();--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'case_law_decisions_redacted_payload_erased'
      AND conrelid = 'case_law_decisions'::regclass
  ) THEN
    ALTER TABLE "case_law_decisions"
      ADD CONSTRAINT "case_law_decisions_redacted_payload_erased"
      CHECK (
        "redacted_at" IS NULL
        OR (
          "fulltext" IS NULL
          AND "sections" IS NULL
          AND "document_ast" IS NULL
          AND "content_hash" IS NULL
        )
      ) NOT VALID;
  END IF;
END
$$;--> statement-breakpoint

-- Exact keys are persisted before a corpus PUT. The table has deliberately no
-- decision FK: a source/delete cascade must not discard erasure cleanup work.
CREATE TABLE "case_law_corpus_upload_intents" (
  "id" uuid PRIMARY KEY NOT NULL,
  "decision_id" uuid NOT NULL,
  "text_s3_key" varchar(512) NOT NULL,
  "normalized_s3_key" varchar(512) NOT NULL,
  "ast_s3_key" varchar(512) NOT NULL,
  "status" varchar(16) DEFAULT 'active' NOT NULL,
  "lease_expires_at" timestamptz NOT NULL,
  "cleanup_attempt_count" integer DEFAULT 0 NOT NULL,
  "next_cleanup_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "case_law_corpus_upload_intents_status_values"
    CHECK ("status" IN ('active', 'cleanup')),
  CONSTRAINT "case_law_corpus_upload_intents_cleanup_schedule"
    CHECK ("status" <> 'cleanup' OR "next_cleanup_at" IS NOT NULL),
  CONSTRAINT "case_law_corpus_upload_intents_cleanup_attempts_nonnegative"
    CHECK ("cleanup_attempt_count" >= 0)
);--> statement-breakpoint

CREATE INDEX "case_law_corpus_upload_intents_cleanup_due_idx"
  ON "case_law_corpus_upload_intents" ("next_cleanup_at", "id")
  WHERE "status" = 'cleanup';--> statement-breakpoint

CREATE UNIQUE INDEX "case_law_corpus_upload_intents_active_decision_uidx"
  ON "case_law_corpus_upload_intents" ("decision_id")
  WHERE "status" = 'active';--> statement-breakpoint

CREATE INDEX "case_law_corpus_upload_intents_active_lease_idx"
  ON "case_law_corpus_upload_intents" ("lease_expires_at", "id")
  WHERE "status" = 'active';--> statement-breakpoint

-- Object keys can expose a redacted payload's location. Keep them out of the
-- application role entirely; only the ingestion role writes them and the root
-- scheduler drains due cleanup work.
ALTER TABLE "case_law_corpus_upload_intents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access"
  ON "case_law_corpus_upload_intents"
  AS PERMISSIVE FOR ALL TO stella_ingestion
  USING (true) WITH CHECK (true);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "case_law_corpus_upload_intents" FROM stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "case_law_corpus_upload_intents" TO stella_ingestion;--> statement-breakpoint
