SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Decisions whose raw objects are owed a sweep: an erasure's follow-up once
-- every write that started before it is over, a write that lost to an
-- erasure, and a write whose row never landed. No foreign key: the record
-- must outlive a row that is being erased or a source that is being removed.
CREATE TABLE IF NOT EXISTS "case_law_raw_sweeps" (
  "decision_id" uuid PRIMARY KEY NOT NULL,
  "source_id" uuid NOT NULL,
  "legacy_payload_keys" varchar(512)[] DEFAULT '{}'::varchar(512)[] NOT NULL,
  "legacy_file_keys" varchar(512)[] DEFAULT '{}'::varchar(512)[] NOT NULL,
  "settle_after" timestamptz NOT NULL,
  "next_attempt_at" timestamptz NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "case_law_raw_sweeps_attempts_nonnegative"
    CHECK ("attempt_count" >= 0)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "case_law_raw_sweeps_due_idx"
  ON "case_law_raw_sweeps" ("next_attempt_at", "decision_id");--> statement-breakpoint

-- Object keys can expose an erased decision's location. Keep them out of the
-- request role entirely; ingestion and the operator erasure record them and
-- the root scheduler drains them.
ALTER TABLE "case_law_raw_sweeps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Drops only the policy the
-- next statement re-creates with the same name and rule, so a re-applied
-- migration re-enters the same state; rollback is dropping the table.
DROP POLICY IF EXISTS "case_law_ingestion_access"
  ON "case_law_raw_sweeps";--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access"
  ON "case_law_raw_sweeps"
  AS PERMISSIVE FOR ALL TO stella_ingestion
  USING (true) WITH CHECK (true);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "case_law_raw_sweeps" FROM stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "case_law_raw_sweeps" TO stella_ingestion;--> statement-breakpoint
