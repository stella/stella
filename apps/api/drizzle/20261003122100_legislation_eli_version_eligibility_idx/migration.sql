SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The dated versions of each Work with the two fields that decide whether a
-- version may apply, so the listing's per-Work probes of eligible versions
-- read no heap. Trailing keys rather than INCLUDE, matching the schema.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

DROP INDEX CONCURRENTLY IF EXISTS "legislation_documents_eli_version_eligibility_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "legislation_documents_eli_version_eligibility_idx"
  ON "legislation_documents" (
    "source_id",
    "eli",
    "version_valid_from",
    "language",
    "window_disposition",
    "expression_kind"
  )
  WHERE "version_valid_from" IS NOT NULL;
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
