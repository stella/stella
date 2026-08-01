SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Rolling tasks may overlap for a bounded drain window. Persist one writer
-- lease per source so only one task can fetch and checkpoint a source cursor.
ALTER TABLE "case_law_sources"
  ADD COLUMN IF NOT EXISTS "ingestion_lease_token" uuid,
  ADD COLUMN IF NOT EXISTS "ingestion_lease_expires_at" timestamptz;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'case_law_sources_ingestion_lease_pair'
      AND conrelid = 'case_law_sources'::regclass
  ) THEN
    ALTER TABLE "case_law_sources"
      ADD CONSTRAINT "case_law_sources_ingestion_lease_pair"
      CHECK (
        ("ingestion_lease_token" IS NULL) =
        ("ingestion_lease_expires_at" IS NULL)
      ) NOT VALID;
  END IF;
END
$$;--> statement-breakpoint

ALTER TABLE "case_law_sources"
  VALIDATE CONSTRAINT "case_law_sources_ingestion_lease_pair";--> statement-breakpoint

-- The ingestion role owns the lease but no other source configuration.
GRANT UPDATE (ingestion_lease_token, ingestion_lease_expires_at)
  ON TABLE "case_law_sources"
  TO stella_ingestion;
