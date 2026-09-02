SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Provenance of a thread created by forking another one at a chosen message.
-- forked_from_message_id is the "this thread is a fork" discriminator and
-- deliberately carries no foreign key: edit and replay truncation delete
-- messages, and provenance must neither block that delete nor disappear with
-- it (same reasoning as recap_message_id).
ALTER TABLE "chat_threads" ADD COLUMN IF NOT EXISTS "parent_thread_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN IF NOT EXISTS "forked_from_message_id" uuid;--> statement-breakpoint

-- SET NULL, not CASCADE: deleting the source thread must not take its forks
-- with it. A null parent beside a non-null forked_from_message_id reads as
-- "forked from a thread that no longer exists".
--
-- NOT VALID keeps the add off the existing-row scan under ACCESS EXCLUSIVE.
-- Every existing row has a NULL parent, so the validation in the following
-- migration is a formality that marks the constraint valid for the planner.
ALTER TABLE "chat_threads"
  ADD CONSTRAINT "chat_threads_parent_thread_id_chat_threads_id_fkey"
  FOREIGN KEY ("parent_thread_id") REFERENCES "chat_threads"("id")
  ON DELETE SET NULL NOT VALID;
