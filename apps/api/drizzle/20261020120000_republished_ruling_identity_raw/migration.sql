SET lock_timeout = '5s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

-- Idempotent: the COMMIT below makes these columns permanent before the
-- concurrent index build, so a rerun after a failed build must pass here.
ALTER TABLE "case_law_decision_source_identities"
  ADD COLUMN IF NOT EXISTS "source_raw_s3_key" varchar(512),
  ADD COLUMN IF NOT EXISTS "source_raw_content_type" varchar(128),
  ADD COLUMN IF NOT EXISTS "source_url" varchar(2048),
  ADD COLUMN IF NOT EXISTS "source_observed_at" timestamptz;--> statement-breakpoint

-- Drizzle wraps migrations in a transaction, but this index covers the live
-- decisions corpus and must be built without blocking its writers.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
-- A cancelled concurrent build can leave an INVALID index with this name.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_republished_ruling_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_decisions_republished_ruling_idx"
  ON "case_law_decisions" ("country", "court", "docket_family_key", "id")
  WHERE "docket_family_key" IS NOT NULL;
--> statement-breakpoint
SET statement_timeout = '30s';
--> statement-breakpoint
SET lock_timeout = '5s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
