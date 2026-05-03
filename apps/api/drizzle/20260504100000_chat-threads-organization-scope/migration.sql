-- stella-migration-safety: reviewed destructive-change - rotate chat RLS policies to add organization_id checks; policies are recreated in the same migration and no table data is dropped.
-- Scope global chat threads to the active organization. This prevents
-- user-owned global rows from following a user across organizations.
ALTER TABLE chat_threads
  ADD COLUMN organization_id varchar(128);

UPDATE chat_threads
SET organization_id = COALESCE(
  (
    SELECT w.organization_id
    FROM workspaces w
    WHERE w.id = chat_threads.workspace_id
  ),
  (
    SELECT m.organization_id
    FROM member m
    WHERE m.user_id = chat_threads.user_id
    ORDER BY m.created_at DESC
    LIMIT 1
  )
)
WHERE organization_id IS NULL;

ALTER TABLE chat_threads
  ALTER COLUMN organization_id SET NOT NULL,
  ADD CONSTRAINT chat_threads_organization_id_organization_id_fk
    FOREIGN KEY (organization_id) REFERENCES organization(id) ON DELETE cascade;

CREATE INDEX chat_threads_organization_user_idx
  ON chat_threads (organization_id, user_id);

DROP POLICY IF EXISTS chat_thread_select ON chat_threads;
DROP POLICY IF EXISTS chat_thread_insert ON chat_threads;
DROP POLICY IF EXISTS chat_thread_update ON chat_threads;
DROP POLICY IF EXISTS chat_thread_delete ON chat_threads;
DROP POLICY IF EXISTS chat_message_select ON chat_messages;
DROP POLICY IF EXISTS chat_message_insert ON chat_messages;
DROP POLICY IF EXISTS chat_message_update ON chat_messages;
DROP POLICY IF EXISTS chat_message_delete ON chat_messages;

CREATE POLICY chat_thread_select ON chat_threads
  FOR SELECT TO stella
  USING (
    user_id = (SELECT current_setting('app.user_id', true))
    AND organization_id = (SELECT current_setting('app.organization_id', true))
    AND (workspace_id IS NULL
         OR workspace_id = ANY((SELECT current_setting('app.workspace_ids', true))::uuid[]))
    AND (cardinality(data_workspace_ids) = 0
         OR data_workspace_ids <@ (SELECT current_setting('app.workspace_ids', true))::uuid[])
  );

CREATE POLICY chat_thread_insert ON chat_threads
  FOR INSERT TO stella
  WITH CHECK (
    user_id = (SELECT current_setting('app.user_id', true))
    AND organization_id = (SELECT current_setting('app.organization_id', true))
    AND (workspace_id IS NULL
         OR workspace_id = ANY((SELECT current_setting('app.workspace_ids', true))::uuid[]))
    AND (cardinality(data_workspace_ids) = 0
         OR data_workspace_ids <@ (SELECT current_setting('app.workspace_ids', true))::uuid[])
  );

CREATE POLICY chat_thread_update ON chat_threads
  FOR UPDATE TO stella
  USING (
    user_id = (SELECT current_setting('app.user_id', true))
    AND organization_id = (SELECT current_setting('app.organization_id', true))
    AND (workspace_id IS NULL
         OR workspace_id = ANY((SELECT current_setting('app.workspace_ids', true))::uuid[]))
    AND (cardinality(data_workspace_ids) = 0
         OR data_workspace_ids <@ (SELECT current_setting('app.workspace_ids', true))::uuid[])
  );

CREATE POLICY chat_thread_delete ON chat_threads
  FOR DELETE TO stella
  USING (
    user_id = (SELECT current_setting('app.user_id', true))
    AND organization_id = (SELECT current_setting('app.organization_id', true))
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
        AND ct.organization_id = (SELECT current_setting('app.organization_id', true))
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
        AND ct.organization_id = (SELECT current_setting('app.organization_id', true))
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
        AND ct.organization_id = (SELECT current_setting('app.organization_id', true))
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
        AND ct.organization_id = (SELECT current_setting('app.organization_id', true))
        AND (cardinality(ct.data_workspace_ids) = 0
             OR ct.data_workspace_ids <@ (SELECT current_setting('app.workspace_ids', true))::uuid[])
    )
  );
