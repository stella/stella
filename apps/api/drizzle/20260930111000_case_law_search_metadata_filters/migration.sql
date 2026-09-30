SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

-- stella-migration-safety: reviewed destructive-change - retry cleanup of an interrupted concurrent build.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_country_category_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_decisions_country_category_idx"
  ON "case_law_decisions" ("country", (CASE WHEN jsonb_typeof("metadata" -> 'category') = 'string'
    AND length("metadata" ->> 'category') <= 128
    THEN "metadata" ->> 'category' END), "id");
--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - retry cleanup of an interrupted concurrent build.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_country_legal_sentence_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_decisions_country_legal_sentence_idx"
  ON "case_law_decisions" ("country", (coalesce(
    jsonb_typeof("metadata" -> 'legalSentence') = 'string'
    AND length(btrim("metadata" ->> 'legalSentence')) > 0, false)), "id");
--> statement-breakpoint

-- squawk-ignore transaction-nesting
BEGIN;
--> statement-breakpoint
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';
