SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The source-wide legacy sweep only needs live pointers outside their own
-- document prefix; a clean source must not scan all of its decisions.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_live_legacy_raw_source_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_decisions_live_legacy_raw_source_idx"
  ON "case_law_decisions" ("source_id", "id")
  WHERE "redacted_at" IS NULL
    AND "source_raw_s3_key" IS NOT NULL
    AND "source_raw_s3_key" NOT LIKE (
      'case-law/raw/' || "source_id"::text || '/documents/' || "id"::text || '/%'
    );
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
