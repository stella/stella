SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A durable tombstone prevents ingestion and deferred-document workers from
-- implicitly restoring payloads after a redaction.
ALTER TABLE "case_law_decisions"
  ADD COLUMN IF NOT EXISTS "redacted_at" timestamptz;--> statement-breakpoint

-- stella-migration-safety: reviewed bulk-backfill - only rows with a redact audit and an already-erased payload are touched; the audit join is keyed by decision_id and the statement timeout bounds the operation.
WITH redactions AS (
  SELECT "decision_id", max("created_at") AS "redacted_at"
  FROM "case_law_index_jobs"
  WHERE "operation" = 'redact'
    AND "decision_id" IS NOT NULL
  GROUP BY "decision_id"
)
UPDATE "case_law_decisions" AS "decision"
SET "redacted_at" = redactions."redacted_at"
FROM redactions
WHERE "decision"."id" = redactions."decision_id"
  AND "decision"."redacted_at" IS NULL
  AND "decision"."fulltext" IS NULL
  AND "decision"."sections" IS NULL
  AND "decision"."document_ast" IS NULL
  AND "decision"."content_hash" IS NULL;--> statement-breakpoint

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
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "decision_id" uuid NOT NULL,
  "text_s3_key" varchar(512) NOT NULL,
  "normalized_s3_key" varchar(512) NOT NULL,
  "ast_s3_key" varchar(512) NOT NULL,
  "status" varchar(16) DEFAULT 'active' NOT NULL,
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
