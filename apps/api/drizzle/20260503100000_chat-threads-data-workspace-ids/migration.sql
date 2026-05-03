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

-- Global threads: derive the data scope from any embedded
-- search-summary citation parts. True conversational global chats
-- have no such parts and keep the empty default ('{}'), which the
-- new RLS predicate treats as "no embedded workspace data" and
-- therefore unrestricted by workspace.
UPDATE chat_threads ct
  SET data_workspace_ids = derived.workspace_ids
  FROM (
    SELECT
      cm.thread_id,
      ARRAY_AGG(DISTINCT (part->'data'->>'workspaceId')::uuid)
        AS workspace_ids
    FROM chat_messages cm,
         LATERAL jsonb_array_elements(cm.content->'data') AS part
    WHERE part->>'type' = 'data-stella-source-document'
      AND part->'data'->>'workspaceId' IS NOT NULL
    GROUP BY cm.thread_id
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
