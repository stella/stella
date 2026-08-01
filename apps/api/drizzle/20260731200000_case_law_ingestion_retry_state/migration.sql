SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- New workers prove that a source cursor was produced under ordered
-- observation handling. Older binaries leave this token unchanged.
ALTER TABLE "case_law_sources"
  ADD COLUMN IF NOT EXISTS "checkpoint_observation_order" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint

-- A mirror write is a durable state transition: pending rows retain their
-- Postgres payload and cannot expose stale object-storage pointers.
ALTER TABLE "case_law_decisions"
  ADD COLUMN IF NOT EXISTS "corpus_mirror_status" varchar(16) DEFAULT 'settled' NOT NULL;--> statement-breakpoint

-- Rolling-deployment bridge: an already-running old backfill writes all four
-- corpus pointer columns but cannot name the new mirror status. Complete old
-- writes atomically so the pending-state CHECK remains compatible with them.
CREATE OR REPLACE FUNCTION settle_legacy_case_law_corpus_mirror()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.corpus_mirror_status = 'pending'
    AND NEW.corpus_mirror_status = 'pending'
    AND NEW.text_s3_key IS NOT NULL
    AND NEW.normalized_s3_key IS NOT NULL
    AND NEW.ast_s3_key IS NOT NULL
    AND NEW.content_hash IS NOT NULL
  THEN
    NEW.corpus_mirror_status := 'settled';
  END IF;
  RETURN NEW;
END
$function$;--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - retry cleanup replaces only this migration's rolling-deployment compatibility trigger; table data is unchanged.
DROP TRIGGER IF EXISTS case_law_decisions_legacy_corpus_mirror_settle
  ON "case_law_decisions";--> statement-breakpoint
CREATE TRIGGER case_law_decisions_legacy_corpus_mirror_settle
BEFORE UPDATE OF text_s3_key, normalized_s3_key, ast_s3_key, content_hash
ON "case_law_decisions"
FOR EACH ROW
EXECUTE FUNCTION settle_legacy_case_law_corpus_mirror();--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'case_law_sources_checkpoint_observation_order_monotonic'
      AND conrelid = 'case_law_sources'::regclass
  ) THEN
    ALTER TABLE "case_law_sources"
      ADD CONSTRAINT "case_law_sources_checkpoint_observation_order_monotonic"
      CHECK ("checkpoint_observation_order" <= "observation_order") NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'case_law_decisions_corpus_mirror_status_values'
      AND conrelid = 'case_law_decisions'::regclass
  ) THEN
    ALTER TABLE "case_law_decisions"
      ADD CONSTRAINT "case_law_decisions_corpus_mirror_status_values"
      CHECK ("corpus_mirror_status" IN ('settled', 'pending')) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'case_law_decisions_pending_corpus_mirror_has_no_pointers'
      AND conrelid = 'case_law_decisions'::regclass
  ) THEN
    ALTER TABLE "case_law_decisions"
      ADD CONSTRAINT "case_law_decisions_pending_corpus_mirror_has_no_pointers"
      CHECK (
        "corpus_mirror_status" = 'settled'
        OR (
          "text_s3_key" IS NULL
          AND "normalized_s3_key" IS NULL
          AND "ast_s3_key" IS NULL
          AND "content_hash" IS NULL
        )
      ) NOT VALID;
  END IF;
END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION hold_legacy_case_law_source_checkpoint()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.checkpoint_observation_order <= OLD.checkpoint_observation_order THEN
    IF NEW.sync_cursor IS DISTINCT FROM OLD.sync_cursor THEN
      NEW.sync_cursor := OLD.sync_cursor;
    END IF;
    NEW.last_sync_at := OLD.last_sync_at;
    NEW.checkpoint_observation_order := OLD.checkpoint_observation_order;
  END IF;
  RETURN NEW;
END
$function$;--> statement-breakpoint

-- stella-migration-safety: reviewed destructive-change - retry cleanup replaces only this migration's compatibility trigger; table data is unchanged.
DROP TRIGGER IF EXISTS case_law_sources_legacy_checkpoint_fence
  ON "case_law_sources";--> statement-breakpoint
CREATE TRIGGER case_law_sources_legacy_checkpoint_fence
BEFORE UPDATE OF sync_cursor ON "case_law_sources"
FOR EACH ROW
EXECUTE FUNCTION hold_legacy_case_law_source_checkpoint();--> statement-breakpoint
