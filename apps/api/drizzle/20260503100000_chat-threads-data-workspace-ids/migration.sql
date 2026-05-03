-- stella-migration-safety: reviewed destructive-change - rotate chat RLS policies to gate reads on data_workspace_ids; existing chat_* policies are recreated as chat_thread_* and chat_message_* with the new subset check.
-- Track which workspaces' content is embedded in a chat thread, so
-- read access can be gated against the user's currently accessible
-- workspaces — not just against the thread's own workspace_id.
--
-- Search-summary threads are stored as global threads (workspace_id
-- IS NULL) but embed citations and excerpts from one or more
-- workspaces. Without this column, a user who later loses access to
-- a contributing workspace can still read the stored content via
-- the global chat list. The new column plus the updated RLS policy
-- gate every read on `data_workspace_ids <@ session_workspace_ids`.
ALTER TABLE chat_threads
  ADD COLUMN IF NOT EXISTS data_workspace_ids uuid[] NOT NULL DEFAULT '{}';

-- Backfill `data_workspace_ids` for every existing chat thread as
-- the union of:
--   (a) the thread's own `workspace_id` (if non-null) — keeps
--       workspace-scoped chats accessible after the new RLS
--       predicate kicks in.
--   (b) every workspace whose content is embedded in any of the
--       thread's messages — `data-stella-source-document` parts
--       (search summaries, document references) and any UUID
--       extracted from text-part HTML (covers
--       `data-source-workspace-id` on entity mentions and
--       `data-id` on workspace mentions). Extracted UUIDs are
--       intersected with the `workspaces` table so noise is
--       dropped.
--
-- This is a single union so a workspace-scoped thread that
-- embedded another workspace's content (e.g., the user attached
-- an entity from matter B inside a chat in matter A) is recorded
-- as `[A, B]` rather than just `[A]`. Without this, the new RLS
-- predicate would still treat the thread as accessible after
-- access to B is revoked, leaving the historical leakage path
-- open for pre-migration data.
--
-- True conversational global chats with no embedded workspace
-- carriers keep the empty default ('{}'), which the new RLS
-- predicate treats as "no embedded workspace data" and therefore
-- unrestricted by workspace.
WITH thread_workspace_refs AS (
  -- Source-document parts carry the workspace ID directly.
  SELECT
    cm.thread_id,
    (part->'data'->>'workspaceId')::uuid AS workspace_id
  FROM chat_messages cm,
       LATERAL jsonb_array_elements(cm.content->'data') AS part
  WHERE part->>'type' = 'data-stella-source-document'
    AND part->'data'->>'workspaceId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

  UNION

  -- Entity-mention HTML inside text parts carries the workspace
  -- in `data-source-workspace-id="<uuid>"`; workspace mentions
  -- carry the workspace ID directly in `data-id="<uuid>"`. Both
  -- are matched by extracting any UUID-shaped substring from the
  -- text and validating against the workspaces table below. This
  -- avoids regex lookbehind (not portable) and tolerates either
  -- attribute order.
  SELECT
    cm.thread_id,
    uuid_match.uuid_text::uuid AS workspace_id
  FROM chat_messages cm,
       LATERAL jsonb_array_elements(cm.content->'data') AS part,
       LATERAL regexp_matches(
         coalesce(part->>'text', ''),
         '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
         'g'
       ) AS rm(captures),
       LATERAL (SELECT rm.captures[1]) AS uuid_match(uuid_text)
  WHERE part->>'type' = 'text'
    AND part->>'text' IS NOT NULL
),
content_workspace_ids AS (
  SELECT
    twr.thread_id,
    ARRAY_AGG(DISTINCT twr.workspace_id) AS workspace_ids
  FROM thread_workspace_refs twr
  WHERE EXISTS (SELECT 1 FROM workspaces w WHERE w.id = twr.workspace_id)
  GROUP BY twr.thread_id
),
thread_final_scope AS (
  -- Compute the final union per thread up-front. Doing this
  -- here keeps the UPDATE's FROM clause flat — Postgres rejects
  -- references to the UPDATE target's alias from inside a JOIN
  -- ON clause, so we cannot `LEFT JOIN content_workspace_ids
  -- cwi ON cwi.thread_id = ct.id` directly off the target.
  SELECT
    ct.id AS thread_id,
    (
      SELECT ARRAY(
        SELECT DISTINCT unnest(
          CASE
            WHEN ct.workspace_id IS NOT NULL
              THEN ARRAY[ct.workspace_id]::uuid[]
            ELSE '{}'::uuid[]
          END || COALESCE(cwi.workspace_ids, '{}'::uuid[])
        )
      )
    ) AS workspace_ids
  FROM chat_threads ct
  LEFT JOIN content_workspace_ids cwi ON cwi.thread_id = ct.id
  WHERE cardinality(ct.data_workspace_ids) = 0
    AND (ct.workspace_id IS NOT NULL OR cwi.thread_id IS NOT NULL)
)
UPDATE chat_threads
  SET data_workspace_ids = tfs.workspace_ids
  FROM thread_final_scope tfs
  WHERE chat_threads.id = tfs.thread_id;

-- The new RLS predicate is added by drizzle from the updated
-- `chatThreadPolicies` / `chatMessagePolicies` definitions; see
-- src/db/rls.ts. Existing 'chat_*' policies are dropped and
-- recreated with the data-workspace-ids check included.
DROP POLICY IF EXISTS chat_select ON chat_threads;
DROP POLICY IF EXISTS chat_insert ON chat_threads;
DROP POLICY IF EXISTS chat_update ON chat_threads;
DROP POLICY IF EXISTS chat_delete ON chat_threads;
DROP POLICY IF EXISTS chat_select ON chat_messages;
DROP POLICY IF EXISTS chat_insert ON chat_messages;
DROP POLICY IF EXISTS chat_update ON chat_messages;
DROP POLICY IF EXISTS chat_delete ON chat_messages;

CREATE POLICY chat_thread_select ON chat_threads
  FOR SELECT TO stella
  USING (
    user_id = (SELECT current_setting('app.user_id', true))
    AND (workspace_id IS NULL
         OR workspace_id = ANY((SELECT current_setting('app.workspace_ids', true))::uuid[]))
    AND (cardinality(data_workspace_ids) = 0
         OR data_workspace_ids <@ (SELECT current_setting('app.workspace_ids', true))::uuid[])
  );

CREATE POLICY chat_thread_insert ON chat_threads
  FOR INSERT TO stella
  WITH CHECK (
    user_id = (SELECT current_setting('app.user_id', true))
    AND (workspace_id IS NULL
         OR workspace_id = ANY((SELECT current_setting('app.workspace_ids', true))::uuid[]))
    AND (cardinality(data_workspace_ids) = 0
         OR data_workspace_ids <@ (SELECT current_setting('app.workspace_ids', true))::uuid[])
  );

CREATE POLICY chat_thread_update ON chat_threads
  FOR UPDATE TO stella
  USING (
    user_id = (SELECT current_setting('app.user_id', true))
    AND (workspace_id IS NULL
         OR workspace_id = ANY((SELECT current_setting('app.workspace_ids', true))::uuid[]))
    AND (cardinality(data_workspace_ids) = 0
         OR data_workspace_ids <@ (SELECT current_setting('app.workspace_ids', true))::uuid[])
  );

CREATE POLICY chat_thread_delete ON chat_threads
  FOR DELETE TO stella
  USING (
    user_id = (SELECT current_setting('app.user_id', true))
    AND (workspace_id IS NULL
         OR workspace_id = ANY((SELECT current_setting('app.workspace_ids', true))::uuid[]))
    AND (cardinality(data_workspace_ids) = 0
         OR data_workspace_ids <@ (SELECT current_setting('app.workspace_ids', true))::uuid[])
  );

CREATE POLICY chat_message_select ON chat_messages
  FOR SELECT TO stella
  USING (
    user_id = (SELECT current_setting('app.user_id', true))
    AND (workspace_id IS NULL
         OR workspace_id = ANY((SELECT current_setting('app.workspace_ids', true))::uuid[]))
    AND EXISTS (
      SELECT 1 FROM chat_threads ct
      WHERE ct.id = chat_messages.thread_id
        AND (cardinality(ct.data_workspace_ids) = 0
             OR ct.data_workspace_ids <@ (SELECT current_setting('app.workspace_ids', true))::uuid[])
    )
  );

CREATE POLICY chat_message_insert ON chat_messages
  FOR INSERT TO stella
  WITH CHECK (
    user_id = (SELECT current_setting('app.user_id', true))
    AND (workspace_id IS NULL
         OR workspace_id = ANY((SELECT current_setting('app.workspace_ids', true))::uuid[]))
    AND EXISTS (
      SELECT 1 FROM chat_threads ct
      WHERE ct.id = chat_messages.thread_id
        AND (cardinality(ct.data_workspace_ids) = 0
             OR ct.data_workspace_ids <@ (SELECT current_setting('app.workspace_ids', true))::uuid[])
    )
  );

CREATE POLICY chat_message_update ON chat_messages
  FOR UPDATE TO stella
  USING (
    user_id = (SELECT current_setting('app.user_id', true))
    AND (workspace_id IS NULL
         OR workspace_id = ANY((SELECT current_setting('app.workspace_ids', true))::uuid[]))
    AND EXISTS (
      SELECT 1 FROM chat_threads ct
      WHERE ct.id = chat_messages.thread_id
        AND (cardinality(ct.data_workspace_ids) = 0
             OR ct.data_workspace_ids <@ (SELECT current_setting('app.workspace_ids', true))::uuid[])
    )
  );

CREATE POLICY chat_message_delete ON chat_messages
  FOR DELETE TO stella
  USING (
    user_id = (SELECT current_setting('app.user_id', true))
    AND (workspace_id IS NULL
         OR workspace_id = ANY((SELECT current_setting('app.workspace_ids', true))::uuid[]))
    AND EXISTS (
      SELECT 1 FROM chat_threads ct
      WHERE ct.id = chat_messages.thread_id
        AND (cardinality(ct.data_workspace_ids) = 0
             OR ct.data_workspace_ids <@ (SELECT current_setting('app.workspace_ids', true))::uuid[])
    )
  );
