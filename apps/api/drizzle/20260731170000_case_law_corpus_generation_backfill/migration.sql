SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "case_law_corpus_index_backfills" (
  "generation" varchar(32) PRIMARY KEY NOT NULL,
  "snapshot_at" timestamptz NOT NULL DEFAULT now(),
  "cursor_created_at" timestamptz,
  "cursor_id" uuid,
  "status" text NOT NULL DEFAULT 'running',
  "lease_token" uuid,
  "lease_expires_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "case_law_corpus_index_backfills_status_values" CHECK ("status" IN ('running','complete')),
  CONSTRAINT "case_law_corpus_index_backfills_cursor_pair" CHECK (("cursor_created_at" IS NULL) = ("cursor_id" IS NULL)),
  CONSTRAINT "case_law_corpus_index_backfills_lease_pair" CHECK (("lease_token" IS NULL) = ("lease_expires_at" IS NULL)),
  CONSTRAINT "case_law_corpus_index_backfills_completed_unleased" CHECK ("status" <> 'complete' OR "lease_token" IS NULL)
);--> statement-breakpoint
ALTER TABLE "case_law_corpus_index_backfills" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $policy$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'case_law_corpus_index_backfills'
      AND policyname = 'case_law_global_access'
  ) THEN
    CREATE POLICY "case_law_global_access"
      ON "case_law_corpus_index_backfills"
      AS PERMISSIVE FOR SELECT TO stella
      USING (true);
  END IF;
END
$policy$;--> statement-breakpoint
DO $policy$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'case_law_corpus_index_backfills'
      AND policyname = 'case_law_ingestion_access'
  ) THEN
    CREATE POLICY "case_law_ingestion_access"
      ON "case_law_corpus_index_backfills"
      AS PERMISSIVE FOR ALL TO stella_ingestion
      USING (true) WITH CHECK (true);
  END IF;
END
$policy$;--> statement-breakpoint
GRANT SELECT ON TABLE "case_law_corpus_index_backfills" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "case_law_corpus_index_backfills" TO stella_ingestion;--> statement-breakpoint

-- Statement time, rather than transaction-start time, makes the rebuild's
-- short table-lock barrier a valid created_at high-water mark.
ALTER TABLE "case_law_decisions"
  ALTER COLUMN "created_at" SET DEFAULT clock_timestamp();--> statement-breakpoint

-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
-- A cancelled concurrent build leaves an INVALID index which IF NOT EXISTS
-- would silently accept on replay. Drop only this migration's index first.
-- stella-migration-safety: reviewed destructive-change - retry cleanup only; no table or column data is removed.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_corpus_generation_cursor_idx";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_decisions_corpus_generation_cursor_idx"
  ON "case_law_decisions" ("created_at", "id");--> statement-breakpoint
-- Refreshes clear indexed_hash while retaining indexed_generation so the
-- indexer can remove a prior jurisdiction copy. Build that durable pending
-- signal under a new name: rolling-deployment tasks still use the legacy
-- indexed_generation predicate until they drain.
-- stella-migration-safety: reviewed destructive-change - retry cleanup removes only this migration's derived-state index.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_corpus_hash_pending_idx";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_decisions_corpus_hash_pending_idx"
  ON "case_law_decisions" ("id")
  WHERE "content_hash" IS NOT NULL AND "indexed_hash" IS NULL;--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - retry cleanup removes only this migration's derived-state index.
DROP INDEX CONCURRENTLY IF EXISTS "legislation_documents_corpus_hash_pending_idx";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "legislation_documents_corpus_hash_pending_idx"
  ON "legislation_documents" ("id")
  WHERE "content_hash" IS NOT NULL AND "indexed_hash" IS NULL;--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;--> statement-breakpoint
