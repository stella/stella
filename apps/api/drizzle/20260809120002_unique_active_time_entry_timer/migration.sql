SET lock_timeout = '1s';
--> statement-breakpoint
-- Duplicate repair scans the retained ledger before the supporting index
-- exists, so keep only the lock timeout while allowing the scan to finish.
SET statement_timeout = 0;
--> statement-breakpoint

-- Older timer starts were not serialized. Preserve the newest running draft
-- timer and close non-draft or older duplicate timers at the minimum valid
-- duration before enforcing the invariant.
-- stella-migration-safety: reviewed bulk-backfill - the update is bounded to non-draft running timers and rows ranked after the newest active draft timer for the same user; normally there are none.
WITH ranked_active_timers AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "user_id"
      ORDER BY
        ("status" = 'draft') DESC,
        "timer_started_at" DESC,
        "id" DESC
    ) AS "timer_rank"
  FROM "time_entries"
  WHERE "timer_started_at" IS NOT NULL
    AND "timer_stopped_at" IS NULL
    AND "user_id" IS NOT NULL
)
UPDATE "time_entries" AS "entry"
SET
  "duration_minutes" = GREATEST("entry"."duration_minutes", 1),
  "billed_minutes" = GREATEST("entry"."billed_minutes", 6),
  "timer_started_at" = NULL,
  "timer_stopped_at" = "entry"."timer_started_at" + INTERVAL '1 minute',
  "updated_at" = NOW()
FROM ranked_active_timers
WHERE "entry"."id" = ranked_active_timers."id"
  AND (
    "entry"."status" <> 'draft'
    OR ranked_active_timers."timer_rank" > 1
  );
--> statement-breakpoint

-- Enforce the one-running-timer invariant at the persistence boundary. Build
-- concurrently so existing time-entry reads and writes continue during setup.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
-- Preserve a valid uniqueness boundary across retries. The migration runner
-- concurrently repairs an interrupted INVALID build before completion.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "time_entries_one_active_timer_per_user_idx"
  ON "time_entries" ("user_id")
  WHERE "timer_started_at" IS NOT NULL;
--> statement-breakpoint
REINDEX INDEX CONCURRENTLY "time_entries_one_active_timer_per_user_idx";
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
