-- Pin a chat thread to a subset of accessible matters.
--
-- The contextMatterIds column drives matter-scoped tool
-- authorization. An empty array means "no matters pinned" — the
-- AI is expected to discover relevant matters via the readonly
-- stella API. A non-empty array narrows tool authorization so the
-- model can only act on the listed matters.
ALTER TABLE chat_threads
  ADD COLUMN IF NOT EXISTS context_matter_ids uuid[] NOT NULL DEFAULT '{}';
