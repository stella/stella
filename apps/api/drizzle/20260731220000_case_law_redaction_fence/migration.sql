SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A durable tombstone prevents ingestion and deferred-document workers from
-- implicitly restoring payloads after a redaction.
ALTER TABLE "case_law_decisions"
  ADD COLUMN IF NOT EXISTS "redacted_at" timestamptz;--> statement-breakpoint

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
