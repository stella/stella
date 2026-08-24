SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "case_law_decision_identifier_backfills" (
  "version" varchar(32) PRIMARY KEY NOT NULL,
  "phase" text DEFAULT 'decisions' NOT NULL,
  "cursor_id" uuid,
  "decisions_scanned" bigint DEFAULT 0 NOT NULL,
  "citations_scanned" bigint DEFAULT 0 NOT NULL,
  "completed_at" timestamptz,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "case_law_decision_identifier_backfills_phase_values"
    CHECK ("phase" IN ('decisions','citations','verify-decisions','verify-citations','complete')),
  CONSTRAINT "case_law_decision_identifier_backfills_counts_nonnegative"
    CHECK ("decisions_scanned" >= 0 AND "citations_scanned" >= 0),
  CONSTRAINT "case_law_decision_identifier_backfills_terminal_shape"
    CHECK (("phase" = 'complete') = ("completed_at" IS NOT NULL)),
  CONSTRAINT "case_law_decision_identifier_backfills_terminal_cursor"
    CHECK ("phase" <> 'complete' OR "cursor_id" IS NULL)
);--> statement-breakpoint

ALTER TABLE "case_law_decision_identifier_backfills" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "case_law_global_access"
  ON "case_law_decision_identifier_backfills"
  AS PERMISSIVE FOR SELECT TO stella
  USING (true);--> statement-breakpoint

CREATE POLICY "case_law_ingestion_access"
  ON "case_law_decision_identifier_backfills"
  AS PERMISSIVE FOR ALL TO stella_ingestion
  USING (true) WITH CHECK (true);--> statement-breakpoint

GRANT SELECT ON TABLE "case_law_decision_identifier_backfills" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "case_law_decision_identifier_backfills" TO stella_ingestion;--> statement-breakpoint

-- The rollout reopens settled citations when a decision's legacy identity
-- changes. Build the exact coalesced lookup before the backfill can run so a
-- page never scans the citation corpus while holding the graph lock.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - removes only this
-- migration's index so a cancelled INVALID build can be retried.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_citations_identifier_backfill_identity_idx";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_citations_identifier_backfill_identity_idx"
  ON "case_law_citations" (
    (coalesce("identifier_type", 'case-number')),
    (coalesce("normalized_identifier_value", "citation_key"))
  )
  WHERE "resolution_status" <> 'pending';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
