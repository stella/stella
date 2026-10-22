-- requires: 20261020093000_cz_uohs_metadata_url_contract
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

ALTER TABLE "case_law_decisions"
  ADD COLUMN IF NOT EXISTS "parsed_source_hash" varchar(64);--> statement-breakpoint

-- Fetch and parse were one atomic write before this migration. Any persisted
-- parsed representation therefore came from the row's current raw generation.
UPDATE "case_law_decisions"
SET "parsed_source_hash" = "source_hash"
WHERE "parsed_source_hash" IS NULL
  AND (
    "fulltext" IS NOT NULL OR "sections" IS NOT NULL OR "document_ast" IS NOT NULL OR
    "text_s3_key" IS NOT NULL OR "normalized_s3_key" IS NOT NULL OR "ast_s3_key" IS NOT NULL
  );--> statement-breakpoint

ALTER TABLE "case_law_replay_blocked"
  ADD COLUMN IF NOT EXISTS "source_hash" varchar(64);--> statement-breakpoint

UPDATE "case_law_replay_blocked" blocked
SET "source_hash" = decision."source_hash"
FROM "case_law_decisions" decision
WHERE blocked."decision_id" = decision."id"
  AND blocked."source_hash" IS NULL;--> statement-breakpoint

ALTER TABLE "case_law_replay_blocked"
  ALTER COLUMN "source_hash" SET NOT NULL;--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - Replaced immediately by the generation-aware primary key; no rows are removed.
ALTER TABLE "case_law_replay_blocked"
  DROP CONSTRAINT IF EXISTS "case_law_replay_blocked_pkey";--> statement-breakpoint
ALTER TABLE "case_law_replay_blocked"
  ADD CONSTRAINT "case_law_replay_blocked_pkey"
  PRIMARY KEY ("decision_id", "source_hash", "parser_version_to");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "case_law_batch_slot_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slot_date" date NOT NULL UNIQUE,
  "status" text NOT NULL,
  "target_parser_versions" jsonb NOT NULL,
  "started_at" timestamptz,
  "finished_at" timestamptz
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "case_law_batch_slot_sources" (
  "slot_run_id" uuid NOT NULL,
  "source_id" uuid NOT NULL,
  "stage" text NOT NULL,
  "starting_cursor" text,
  "lease_token" uuid,
  "status" text NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "retry_at" timestamptz,
  "failure_code" text,
  PRIMARY KEY ("slot_run_id", "source_id")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "case_law_fetch_item_receipts" (
  "source_id" uuid NOT NULL,
  "source_document_identity" text NOT NULL,
  "raw_hash" varchar(64) NOT NULL,
  "outcome" text NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "retry_at" timestamptz,
  PRIMARY KEY ("source_id", "source_document_identity", "raw_hash")
);--> statement-breakpoint

DO $constraints$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'case_law_batch_slot_runs_status_check' AND conrelid = 'case_law_batch_slot_runs'::regclass) THEN
    ALTER TABLE "case_law_batch_slot_runs" ADD CONSTRAINT "case_law_batch_slot_runs_status_check" CHECK ("status" IN ('pending', 'running', 'completed', 'failed')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'case_law_batch_slot_sources_run_fk' AND conrelid = 'case_law_batch_slot_sources'::regclass) THEN
    ALTER TABLE "case_law_batch_slot_sources" ADD CONSTRAINT "case_law_batch_slot_sources_run_fk" FOREIGN KEY ("slot_run_id") REFERENCES "case_law_batch_slot_runs"("id") ON DELETE RESTRICT NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'case_law_batch_slot_sources_source_fk' AND conrelid = 'case_law_batch_slot_sources'::regclass) THEN
    ALTER TABLE "case_law_batch_slot_sources" ADD CONSTRAINT "case_law_batch_slot_sources_source_fk" FOREIGN KEY ("source_id") REFERENCES "case_law_sources"("id") ON DELETE RESTRICT NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'case_law_batch_slot_sources_stage_check' AND conrelid = 'case_law_batch_slot_sources'::regclass) THEN
    ALTER TABLE "case_law_batch_slot_sources" ADD CONSTRAINT "case_law_batch_slot_sources_stage_check" CHECK ("stage" IN ('fetch', 'parse', 'complete')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'case_law_batch_slot_sources_status_check' AND conrelid = 'case_law_batch_slot_sources'::regclass) THEN
    ALTER TABLE "case_law_batch_slot_sources" ADD CONSTRAINT "case_law_batch_slot_sources_status_check" CHECK ("status" IN ('pending', 'leased', 'retryable', 'completed', 'failed')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'case_law_batch_slot_sources_attempt_count_check' AND conrelid = 'case_law_batch_slot_sources'::regclass) THEN
    ALTER TABLE "case_law_batch_slot_sources" ADD CONSTRAINT "case_law_batch_slot_sources_attempt_count_check" CHECK ("attempt_count" >= 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'case_law_fetch_item_receipts_source_fk' AND conrelid = 'case_law_fetch_item_receipts'::regclass) THEN
    ALTER TABLE "case_law_fetch_item_receipts" ADD CONSTRAINT "case_law_fetch_item_receipts_source_fk" FOREIGN KEY ("source_id") REFERENCES "case_law_sources"("id") ON DELETE RESTRICT NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'case_law_fetch_item_receipts_outcome_check' AND conrelid = 'case_law_fetch_item_receipts'::regclass) THEN
    ALTER TABLE "case_law_fetch_item_receipts" ADD CONSTRAINT "case_law_fetch_item_receipts_outcome_check" CHECK ("outcome" IN ('stored', 'unchanged', 'retryable', 'refused', 'absent')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'case_law_fetch_item_receipts_attempt_count_check' AND conrelid = 'case_law_fetch_item_receipts'::regclass) THEN
    ALTER TABLE "case_law_fetch_item_receipts" ADD CONSTRAINT "case_law_fetch_item_receipts_attempt_count_check" CHECK ("attempt_count" >= 0) NOT VALID;
  END IF;
END $constraints$;--> statement-breakpoint

ALTER TABLE "case_law_batch_slot_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_batch_slot_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_fetch_item_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DO $policies$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'case_law_batch_slot_runs_owner_access' AND polrelid = 'case_law_batch_slot_runs'::regclass) THEN
    CREATE POLICY "case_law_batch_slot_runs_owner_access" ON "case_law_batch_slot_runs" FOR ALL TO public USING ((SELECT current_user = pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_batch_slot_runs'::regclass)) WITH CHECK ((SELECT current_user = pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_batch_slot_runs'::regclass));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'case_law_batch_slot_sources_owner_access' AND polrelid = 'case_law_batch_slot_sources'::regclass) THEN
    CREATE POLICY "case_law_batch_slot_sources_owner_access" ON "case_law_batch_slot_sources" FOR ALL TO public USING ((SELECT current_user = pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_batch_slot_sources'::regclass)) WITH CHECK ((SELECT current_user = pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_batch_slot_sources'::regclass));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'case_law_fetch_item_receipts_owner_access' AND polrelid = 'case_law_fetch_item_receipts'::regclass) THEN
    CREATE POLICY "case_law_fetch_item_receipts_owner_access" ON "case_law_fetch_item_receipts" FOR ALL TO public USING ((SELECT current_user = pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_fetch_item_receipts'::regclass)) WITH CHECK ((SELECT current_user = pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_fetch_item_receipts'::regclass));
  END IF;
END $policies$;--> statement-breakpoint

-- Release table locks before validation scans and the concurrent index build.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;--> statement-breakpoint

ALTER TABLE "case_law_batch_slot_runs" VALIDATE CONSTRAINT "case_law_batch_slot_runs_status_check";--> statement-breakpoint
ALTER TABLE "case_law_batch_slot_sources" VALIDATE CONSTRAINT "case_law_batch_slot_sources_run_fk";--> statement-breakpoint
ALTER TABLE "case_law_batch_slot_sources" VALIDATE CONSTRAINT "case_law_batch_slot_sources_source_fk";--> statement-breakpoint
ALTER TABLE "case_law_batch_slot_sources" VALIDATE CONSTRAINT "case_law_batch_slot_sources_stage_check";--> statement-breakpoint
ALTER TABLE "case_law_batch_slot_sources" VALIDATE CONSTRAINT "case_law_batch_slot_sources_status_check";--> statement-breakpoint
ALTER TABLE "case_law_batch_slot_sources" VALIDATE CONSTRAINT "case_law_batch_slot_sources_attempt_count_check";--> statement-breakpoint
ALTER TABLE "case_law_fetch_item_receipts" VALIDATE CONSTRAINT "case_law_fetch_item_receipts_source_fk";--> statement-breakpoint
ALTER TABLE "case_law_fetch_item_receipts" VALIDATE CONSTRAINT "case_law_fetch_item_receipts_outcome_check";--> statement-breakpoint
ALTER TABLE "case_law_fetch_item_receipts" VALIDATE CONSTRAINT "case_law_fetch_item_receipts_attempt_count_check";--> statement-breakpoint

-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
-- squawk-ignore ban-concurrent-index-creation-in-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS "case_law_decisions_parse_pending_idx"
  ON "case_law_decisions" ("id")
  WHERE "parsed_source_hash" IS DISTINCT FROM "source_hash";--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
