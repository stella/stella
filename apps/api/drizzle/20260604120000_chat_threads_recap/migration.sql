-- Lazy "where you left off" recap cache for chat threads. When a user
-- reopens a thread after a gap, a short recap of what was discussed
-- and what still remains is generated from the transcript and cached
-- on the thread row, keyed by the latest message id and the prompt
-- version so it regenerates when either changes.
--
-- The recap columns are nullable and default to NULL; existing threads
-- carry no recap until their first stale revisit generates one. The
-- anonymization flag defaults false and is backfilled below so recap
-- generation can skip those threads before reading message content.
-- This is additive: no RLS change (the thread's existing row-level
-- policies already govern these columns).
ALTER TABLE chat_threads
  ADD COLUMN IF NOT EXISTS recap_text text,
  ADD COLUMN IF NOT EXISTS recap_message_id uuid,
  ADD COLUMN IF NOT EXISTS recap_prompt_version smallint,
  ADD COLUMN IF NOT EXISTS recap_generated_at timestamp,
  ADD COLUMN IF NOT EXISTS used_anonymization boolean NOT NULL DEFAULT false;

UPDATE chat_threads
SET used_anonymization = true
WHERE used_anonymization = false
  AND EXISTS (
    SELECT 1
    FROM chat_messages
    WHERE chat_messages.thread_id = chat_threads.id
      AND chat_messages.content @> '{"data":[{"type":"data-stella-anon-restorations"}]}'::jsonb
  );
