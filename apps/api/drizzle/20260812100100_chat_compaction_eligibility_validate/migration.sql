SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- Kept in a separate transaction from the ADD ... NOT VALID in the previous
-- migration, which is what makes the pair lock-safe: the constraint began
-- enforcing every write the moment it was added, and this scan takes only
-- SHARE UPDATE EXCLUSIVE, so it blocks neither reads nor writes.
--
-- The scan cannot fail on data: memory_eligibility is added by the previous
-- migration with a constant default and is only ever written from
-- CHAT_COMPACTION_MEMORY_ELIGIBILITIES, so every row conforms by construction.
-- Marking the constraint valid is what makes a migrated database structurally
-- identical to schema.ts, which declares an ordinary constraint.
ALTER TABLE "chat_thread_compactions" VALIDATE CONSTRAINT "chat_thread_compactions_memory_eligibility_check";
