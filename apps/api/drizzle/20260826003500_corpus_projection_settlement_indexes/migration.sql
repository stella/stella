SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Cleanup claims select ready work per index. Settlement first selects the
-- oldest committed cleanup, then claims a bounded batch sharing its delete
-- opstamp. Build all matching access paths without blocking projection writers
-- during a table scan.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint

DROP INDEX CONCURRENTLY IF EXISTS "corpus_index_projection_intents_cleanup_claim_idx";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- IF NOT EXISTS would retain an INVALID index left by an interrupted concurrent build
CREATE INDEX CONCURRENTLY "corpus_index_projection_intents_cleanup_claim_idx"
  ON "corpus_index_projection_intents" (
    "family", "generation", "index_id", "status", "cleanup_not_before", "created_at"
  )
  WHERE "status" = 'cleanup_pending';--> statement-breakpoint

DROP INDEX CONCURRENTLY IF EXISTS "corpus_index_projection_intents_settlement_next_idx";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- IF NOT EXISTS would retain an INVALID index left by an interrupted concurrent build
CREATE INDEX CONCURRENTLY "corpus_index_projection_intents_settlement_next_idx"
  ON "corpus_index_projection_intents" (
    "family", "generation", "index_id", "status", "cleanup_started_at", "created_at"
  )
  WHERE "status" = 'cleanup_committed';--> statement-breakpoint

DROP INDEX CONCURRENTLY IF EXISTS "corpus_index_projection_intents_settlement_batch_idx";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts -- IF NOT EXISTS would retain an INVALID index left by an interrupted concurrent build
CREATE INDEX CONCURRENTLY "corpus_index_projection_intents_settlement_batch_idx"
  ON "corpus_index_projection_intents" (
    "family", "generation", "index_id", "status", "delete_opstamp", "created_at"
  )
  WHERE "status" = 'cleanup_committed';--> statement-breakpoint

SET statement_timeout = '5s';--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
