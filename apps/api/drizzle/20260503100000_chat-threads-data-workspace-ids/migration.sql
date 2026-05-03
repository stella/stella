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

-- Workspace-scoped threads: their data scope is exactly that
-- workspace. This keeps existing matter chats accessible after the
-- new RLS predicate kicks in.
UPDATE chat_threads
  SET data_workspace_ids = ARRAY[workspace_id]::uuid[]
  WHERE workspace_id IS NOT NULL
    AND cardinality(data_workspace_ids) = 0;

-- Global threads: derive the data scope from every workspace-
-- bearing carrier we know about — `data-stella-source-document`
-- parts (search summaries, document references) and entity-
-- mention or workspace-mention HTML inside text parts. UUID-
-- shaped strings extracted from text are then intersected with
-- the workspaces table so noise (any UUID-looking substring) is
-- dropped. True conversational global chats have no such carriers
-- and keep the empty default ('{}'), which the new RLS predicate
-- treats as "no embedded workspace data" and therefore unrestricted
-- by workspace.
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
)
UPDATE chat_threads ct
  SET data_workspace_ids = derived.workspace_ids
  FROM (
    SELECT
      twr.thread_id,
      ARRAY_AGG(DISTINCT twr.workspace_id) AS workspace_ids
    FROM thread_workspace_refs twr
    -- Drop UUIDs that aren't actually workspaces in this DB.
    WHERE EXISTS (
      SELECT 1 FROM workspaces w WHERE w.id = twr.workspace_id
    )
    GROUP BY twr.thread_id
  ) AS derived
  WHERE ct.id = derived.thread_id
    AND ct.workspace_id IS NULL
    AND cardinality(ct.data_workspace_ids) = 0;

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
