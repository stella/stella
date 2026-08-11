SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- Durable queue address for incremental chat-thread compaction. A send whose
-- history window crosses the compaction trigger stamps compaction_scheduled_at;
-- the compactor claims a due thread by overwriting it with a lease expiry and
-- settles it with a compare-and-set on that token, so a send that wakes the
-- thread mid-run is never erased. compaction_attempted_at rotates failed
-- threads behind untouched work.
ALTER TABLE "chat_threads" ADD COLUMN IF NOT EXISTS "compaction_scheduled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN IF NOT EXISTS "compaction_attempted_at" timestamp with time zone;--> statement-breakpoint
-- delta_cursor is the encoded (created_at, id) keyset cursor of the last
-- message this checkpoint chain summarized. Every run reads only the bounded
-- delta after it, so no run rereads lifetime history. Null on rows written
-- before this migration; those chains resume from the start of the thread and
-- re-anchor on their next run.
ALTER TABLE "chat_thread_compactions" ADD COLUMN IF NOT EXISTS "delta_cursor" text;--> statement-breakpoint
-- Messages summarized by the whole checkpoint chain. summarized_message_count
-- stays per-run so the memory extractor's [first_summarized..last_summarized]
-- transcript range remains bounded; this column carries the cumulative total
-- the prompt's summary header reports. A constant default is metadata-only on
-- PostgreSQL 11+, so no table rewrite.
ALTER TABLE "chat_thread_compactions" ADD COLUMN IF NOT EXISTS "total_summarized_message_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- chat_threads is large and hot; build the claim index concurrently. Remove
-- the statement timeout before leaving Drizzle's transaction wrapper.
SET statement_timeout = 0;--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - drops only an index this migration introduces, and only the possibly INVALID leftover of an interrupted concurrent build; the next statement rebuilds it before the migration completes.
DROP INDEX CONCURRENTLY IF EXISTS "chat_threads_compaction_due_idx";
--> statement-breakpoint
-- Serves the compactor's claim seek: due threads oldest-first, with
-- never-attempted work ahead of previously failed work. Created without
-- IF NOT EXISTS on purpose: that clause would skip an INVALID index left by an
-- interrupted build, so the drop above is the retry-safe postcondition instead.
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "chat_threads_compaction_due_idx" ON "chat_threads" ("compaction_scheduled_at", "compaction_attempted_at" ASC NULLS FIRST, "id") WHERE compaction_scheduled_at IS NOT NULL;
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
--> statement-breakpoint
SET statement_timeout = '5s';
