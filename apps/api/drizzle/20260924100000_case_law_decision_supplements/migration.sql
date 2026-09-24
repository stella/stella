SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Documents a publisher serves under their own id that belong inside another
-- decision's document, such as the written reasons SAOS publishes apart from
-- the ruling they explain. The row keeps the supplement's parsed text so every
-- later write of its judgment can compose it again; decision_id names the
-- judgment whose document includes it, merged_source_hash the version it
-- included, and a row without a judgment is parked until one is stored.
--
-- Every statement can be run again: a database that applied this file under
-- an earlier name re-enters the same state.
CREATE TABLE IF NOT EXISTS "case_law_decision_supplements" (
  "source_id" uuid NOT NULL,
  "source_document_id" varchar(256) NOT NULL,
  "kind" varchar(16) NOT NULL,
  "case_number" varchar(256) NOT NULL,
  "court" varchar(512) NOT NULL,
  "language" varchar(8) NOT NULL,
  "latest_decision_date" date,
  "judgment_decision_types" varchar(128)[] NOT NULL,
  "fulltext" text,
  "document_ast" jsonb NOT NULL,
  "source_hash" varchar(64) NOT NULL,
  "source_url" varchar(2048),
  "document_url" varchar(2048),
  "metadata" jsonb NOT NULL,
  "source_raw_s3_key" varchar(512),
  "source_raw_content_type" varchar(128),
  "decision_id" uuid,
  "merged_source_hash" varchar(64),
  "observed_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "case_law_decision_supplements_pk"
    PRIMARY KEY ("source_id", "source_document_id")
);--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'case_law_decision_supplements_source_fk'
      AND conrelid = 'case_law_decision_supplements'::regclass
  ) THEN
    ALTER TABLE "case_law_decision_supplements"
      ADD CONSTRAINT "case_law_decision_supplements_source_fk"
      FOREIGN KEY ("source_id") REFERENCES "public"."case_law_sources"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

-- Validating rather than NOT VALID + VALIDATE: the table is created empty in
-- this migration, so the scan is over no rows. The referenced table is only
-- read for existence, and the lock this takes on it is SHARE ROW EXCLUSIVE,
-- which the corpus schema lane has already drained writers for.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'case_law_decision_supplements_decision_fk'
      AND conrelid = 'case_law_decision_supplements'::regclass
  ) THEN
    ALTER TABLE "case_law_decision_supplements"
      ADD CONSTRAINT "case_law_decision_supplements_decision_fk"
      FOREIGN KEY ("decision_id") REFERENCES "public"."case_law_decisions"("id")
      ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

-- The judgment a supplement joins is found by court, docket and language.
CREATE INDEX IF NOT EXISTS "case_law_decision_supplements_target_idx"
  ON "case_law_decision_supplements" ("source_id","court","case_number","language");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "case_law_decision_supplements_decision_idx"
  ON "case_law_decision_supplements" ("decision_id")
  WHERE "decision_id" IS NOT NULL;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'case_law_decision_supplements_kind_values'
      AND conrelid = 'case_law_decision_supplements'::regclass
  ) THEN
    ALTER TABLE "case_law_decision_supplements"
      ADD CONSTRAINT "case_law_decision_supplements_kind_values"
      CHECK ("kind" IN ('reasons'));
  END IF;
END $$;--> statement-breakpoint

-- A merged supplement names the version its judgment composed. A judgment
-- deleted from under it nulls decision_id and leaves the hash: parked again.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'case_law_decision_supplements_merged_has_hash'
      AND conrelid = 'case_law_decision_supplements'::regclass
  ) THEN
    ALTER TABLE "case_law_decision_supplements"
      ADD CONSTRAINT "case_law_decision_supplements_merged_has_hash"
      CHECK ("decision_id" IS NULL OR "merged_source_hash" IS NOT NULL);
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "case_law_decision_supplements"
  ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Drops only the policy the
-- next statement re-creates with the same name and rule, so a re-applied
-- migration re-enters the same state; rollback is dropping the table.
DROP POLICY IF EXISTS "case_law_ingestion_access"
  ON "case_law_decision_supplements";--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access"
  ON "case_law_decision_supplements"
  AS PERMISSIVE FOR ALL TO stella_ingestion
  USING (true) WITH CHECK (true);--> statement-breakpoint
REVOKE ALL PRIVILEGES
  ON TABLE "case_law_decision_supplements" FROM stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "case_law_decision_supplements" TO stella_ingestion;
