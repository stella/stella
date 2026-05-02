-- Drop the "uninitialized" property status. It was a dead state:
-- nothing transitioned out of it (only `update-by-id` ever set
-- "stale", and only after a user-driven property edit), and the
-- workflow planner skipped it. Newly-created AI properties got
-- stuck there forever — the workspace optimistic UI showed
-- "Calculating…" indefinitely because no field row was ever
-- written. With "uninitialized" gone, every property is either
-- "stale" (needs computation) or "fresh" (computed). The default
-- is also dropped so callers must pick the correct initial state
-- explicitly: AI properties → "stale", manual properties → "fresh".

UPDATE "properties"
SET "status" = CASE
  WHEN ("tool" ->> 'type') = 'ai-model' THEN 'stale'
  ELSE 'fresh'
END
WHERE "status" = 'uninitialized';--> statement-breakpoint
ALTER TABLE "properties" ALTER COLUMN "status" DROP DEFAULT;
