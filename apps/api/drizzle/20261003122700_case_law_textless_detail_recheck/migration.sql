SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint
ALTER TABLE "case_law_decisions"
  ADD COLUMN IF NOT EXISTS "textless_detail_rechecked_at" timestamptz;--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_textless_detail_recheck_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "case_law_decisions_textless_detail_recheck_idx"
  ON "case_law_decisions" (
    "source_id",
    (coalesce("textless_detail_rechecked_at", "updated_at")),
    "id"
  )
  WHERE "fulltext" IS NULL
    AND jsonb_extract_path_text("metadata", '_stellaPartialObservation', 'isListingOnly') = 'true'
    AND "redacted_at" IS NULL;--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
