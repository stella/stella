SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Which run owns a pending cell. A run claims the cells it queued under one
-- id and writes back only the rows still holding it, so a run that stalled
-- past the stale window and then woke up cannot overwrite the answer the run
-- that reclaimed its cells produced. Nullable and additive: existing pending
-- rows hold NULL, which matches no claim, so the next run reclaims them at
-- the stale window exactly as it does today.
ALTER TABLE "case_law_research_answers" ADD COLUMN "claim_id" uuid;
