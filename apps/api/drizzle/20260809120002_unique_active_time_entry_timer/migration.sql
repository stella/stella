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
    "duration_minutes",
    "billed_minutes",
    "timer_started_at",
    "timer_stopped_at",
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
),
timers_to_repair AS MATERIALIZED (
  SELECT ranked_active_timers.*
  FROM ranked_active_timers
  INNER JOIN "time_entries" AS "entry"
    ON "entry"."id" = ranked_active_timers."id"
  WHERE "entry"."status" <> 'draft'
    OR ranked_active_timers."timer_rank" > 1
),
repaired_timers AS (
  UPDATE "time_entries" AS "entry"
  SET
    "duration_minutes" = GREATEST("entry"."duration_minutes", 1),
    -- Billed entries already contributed their snapshotted minutes to an
    -- invoice total. Closing a legacy timer must not rewrite that financial
    -- quantity underneath a materialized invoice.
    "billed_minutes" = CASE
      WHEN "entry"."status" = 'billed' THEN "entry"."billed_minutes"
      ELSE GREATEST("entry"."billed_minutes", 6)
    END,
    "timer_started_at" = NULL,
    "timer_stopped_at" = "entry"."timer_started_at" + INTERVAL '1 minute',
    "updated_at" = NOW()
  FROM timers_to_repair
  WHERE "entry"."id" = timers_to_repair."id"
  RETURNING
    "entry"."id",
    "entry"."organization_id",
    "entry"."workspace_id",
    "entry"."user_id",
    "entry"."status"
)
INSERT INTO "audit_logs" (
  "id",
  "organization_id",
  "workspace_id",
  "user_id",
  "action",
  "resource_type",
  "resource_id",
  "metadata",
  "changes",
  "performer_type",
  "performer_id",
  "performer_name",
  "trigger_type",
  "trigger_source",
  "trigger_source_id",
  "activity_category"
)
SELECT
  gen_random_uuid(),
  repaired_timers."organization_id",
  repaired_timers."workspace_id",
  repaired_timers."user_id",
  'update',
  'time_entry',
  repaired_timers."id",
  jsonb_build_object('cause', 'legacy_active_timer_repair'),
  jsonb_build_object(
    'durationMinutes', jsonb_build_object(
      'old', timers_to_repair."duration_minutes",
      'new', GREATEST(timers_to_repair."duration_minutes", 1)
    ),
    'billedMinutes', jsonb_build_object(
      'old', timers_to_repair."billed_minutes",
      'new', CASE
        WHEN repaired_timers."status" = 'billed'
          THEN timers_to_repair."billed_minutes"
        ELSE GREATEST(timers_to_repair."billed_minutes", 6)
      END
    ),
    'timerStartedAt', jsonb_build_object(
      'old', timers_to_repair."timer_started_at",
      'new', NULL
    ),
    'timerStoppedAt', jsonb_build_object(
      'old', timers_to_repair."timer_stopped_at",
      'new', timers_to_repair."timer_started_at" + INTERVAL '1 minute'
    )
  ),
  'service',
  'database-migration',
  'Time entry timer repair',
  'system',
  'database_migration',
  '20260809120002_unique_active_time_entry_timer',
  'other'
FROM repaired_timers
INNER JOIN timers_to_repair
  ON timers_to_repair."id" = repaired_timers."id";
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
