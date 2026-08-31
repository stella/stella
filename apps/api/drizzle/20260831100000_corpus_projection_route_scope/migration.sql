SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Route-scoped workers claim by desired physical index and then by runnable
-- age. Keep the generation-wide queue index too: broad recovery remains a
-- supported primitive, while this access path lets disjoint route workers
-- avoid scanning and contending on another route's backlog.
--
-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires CREATE INDEX CONCURRENTLY outside one. Split the transaction and
-- restore it for the migrator's bookkeeping row after the online build.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

-- a cancelled concurrent build can leave an INVALID index with this name.
DROP INDEX CONCURRENTLY IF EXISTS "corpus_index_projection_states_pending_route_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "corpus_index_projection_states_pending_route_idx"
  ON "corpus_index_projection_states" (
    "family",
    "generation",
    "desired_index_id",
    (coalesce("retry_not_before", "updated_at")),
    "entity_id"
  )
  WHERE "work_status" = 'repair_scheduled'
    OR (
      "work_status" IN ('eligible', 'retry_scheduled')
      AND (
        "applied_action" IS NULL
        OR "applied_action" IS DISTINCT FROM "desired_action"
        OR "applied_epoch" IS DISTINCT FROM "desired_epoch"
        OR "applied_fingerprint" IS DISTINCT FROM "desired_fingerprint"
        OR "applied_index_id" IS DISTINCT FROM "desired_index_id"
      )
    );
--> statement-breakpoint

-- Replacement claims intentionally include blocked desired work: cleanup of
-- an already published older revision remains required even when the newer
-- projection exhausted its append retries. That broader predicate cannot use
-- the pending-work index, so give route workers their exact sparse queue.
-- cancelled concurrent build can leave an INVALID index with this name.
DROP INDEX CONCURRENTLY IF EXISTS "corpus_index_projection_states_replacement_route_idx";
--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "corpus_index_projection_states_replacement_route_idx"
  ON "corpus_index_projection_states" (
    "family",
    "generation",
    "desired_index_id",
    "updated_at",
    "entity_id"
  )
  WHERE "desired_action" = 'upsert'
    AND "applied_action" = 'upsert'
    AND "applied_revision" IS NOT NULL
    AND "applied_index_id" IS NOT NULL
    AND "desired_epoch" > "applied_epoch";
--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
