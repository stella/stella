-- Lazy "where you left off" recap cache for chat threads. When a user
-- reopens a thread after a gap, a short recap of what was discussed
-- and what still remains is generated from the transcript and cached
-- on the thread row, keyed by the latest message id and the prompt
-- version so it regenerates when either changes.
--
-- All four columns are nullable and default to NULL; existing threads
-- carry no recap until their first stale revisit generates one. This
-- is purely additive: no rewrite, no constraint, no RLS change (the
-- thread's existing row-level policies already govern these columns).
ALTER TABLE chat_threads
  ADD COLUMN IF NOT EXISTS recap_text text,
  ADD COLUMN IF NOT EXISTS recap_message_id uuid,
  ADD COLUMN IF NOT EXISTS recap_prompt_version smallint,
  ADD COLUMN IF NOT EXISTS recap_generated_at timestamp;
