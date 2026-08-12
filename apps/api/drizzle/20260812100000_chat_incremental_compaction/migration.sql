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
-- Bumped whenever an edit, replay, or delete invalidates the checkpoint chain.
-- The compactor compares it under the thread lock before writing, which is the
-- only guard that works on a thread with no active checkpoint to mark stale.
ALTER TABLE "chat_threads" ADD COLUMN IF NOT EXISTS "compaction_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- delta_cursor is the encoded (created_at, id) keyset cursor of the last
-- message this checkpoint chain summarized. Every run reads only the bounded
-- delta after it, so no run rereads lifetime history. Backfilled below for
-- chains that predate the column.
ALTER TABLE "chat_thread_compactions" ADD COLUMN IF NOT EXISTS "delta_cursor" text;--> statement-breakpoint
-- Messages summarized by the whole checkpoint chain. summarized_message_count
-- stays per-run so the memory extractor's [first_summarized..last_summarized]
-- transcript range remains bounded; this column carries the cumulative total
-- the prompt's summary header reports. A constant default is metadata-only on
-- PostgreSQL 11+, so no table rewrite.
ALTER TABLE "chat_thread_compactions" ADD COLUMN IF NOT EXISTS "total_summarized_message_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Whether this summary may be mined for AI memory, and when not, why.
-- Compaction summaries are cumulative, so extractability cannot be re-derived
-- from the messages a summary replaced: it is recorded on the segment that
-- summarized them and inherited by every later segment. Existing rows default
-- to 'unknown' (not extractable) because their provenance was never recorded;
-- the backfill below promotes the ones whose provenance IS recoverable.
ALTER TABLE "chat_thread_compactions" ADD COLUMN IF NOT EXISTS "memory_eligibility" varchar(20) DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_thread_compactions" DROP CONSTRAINT IF EXISTS "chat_thread_compactions_memory_eligibility_check";--> statement-breakpoint
-- NOT VALID: enforced for every write from this statement on, without the
-- ACCESS EXCLUSIVE scan of the existing rows. chat_thread_compactions carries
-- one row per compaction per thread and grows with chat use, so that scan is
-- not something to take under lock. The rows are trivially conforming — the
-- column is added above with a constant default and only ever written from
-- CHAT_COMPACTION_MEMORY_ELIGIBILITIES — so the validation below is a
-- formality that marks the constraint valid for the planner.
ALTER TABLE "chat_thread_compactions" ADD CONSTRAINT "chat_thread_compactions_memory_eligibility_check" CHECK (memory_eligibility IN ('eligible', 'message-opted-out', 'consent-inactive', 'unknown')) NOT VALID;--> statement-breakpoint
-- Backfill the chains that predate these columns. Bounded by the partial unique
-- index on (thread_id) WHERE status = 'active': at most one row per thread, not
-- one per compaction.
--
-- Without this, the next run would read the delta from message zero while also
-- passing the existing cumulative summary as the previous checkpoint, folding
-- already-summarized messages into it a second time, and the header count would
-- under-report for the rest of the chain's life.
--
-- delta_cursor reproduces the application's timestamp+id cursor codec exactly:
-- base64url (no padding) of the JSON pair [to_char(created_at), id]. An
-- integration test pins this expression against the codec, because a cursor
-- this side cannot decode reads as "no cursor" and silently restarts at zero.
--
-- memory_eligibility is only recoverable where the previous writer left
-- memory_extracted_at NULL: that writer stamped the column whenever the
-- deployment flag was off or any summarized message was opted out, so a NULL
-- stamp IS a recorded decision that every summarized message was eligible. A
-- non-NULL stamp is ambiguous (excluded, or already mined) and stays 'unknown'.
UPDATE "chat_thread_compactions" AS compaction
SET
	"delta_cursor" = translate(
		replace(
			encode(
				convert_to(
					'["' || to_char(boundary.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '","' || boundary.id::text || '"]',
					'UTF8'
				),
				'base64'
			),
			chr(10),
			''
		),
		'+/=',
		'-_'
	),
	"total_summarized_message_count" = compaction.summarized_message_count,
	"memory_eligibility" = CASE
		WHEN compaction.memory_extracted_at IS NULL THEN 'eligible'
		ELSE 'unknown'
	END
FROM "chat_messages" AS boundary
WHERE boundary.id = compaction.last_summarized_message_id
	AND compaction.status = 'active'
	AND compaction.delta_cursor IS NULL;--> statement-breakpoint
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
