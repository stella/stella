SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint

-- A reference comparison is now judged for a side (buyer, seller, or
-- neutral). Runs pinned before that had no side, which is what `neutral`
-- records.
UPDATE "document_review_runs"
SET "basis" = "basis" || '{"perspective":"neutral"}'::jsonb
WHERE "basis" ->> 'type' IN ('references', 'combined')
  AND NOT ("basis" ? 'perspective');
