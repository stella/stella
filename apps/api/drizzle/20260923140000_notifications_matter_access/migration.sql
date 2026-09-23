SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- stella-migration-safety: reviewed alter-policy - adds a condition to the existing recipient and organization check, so it only narrows visibility; rollback restores the previous USING expression
ALTER POLICY "user_select"
  ON "notifications"
  USING ((
  (user_id =
  (SELECT current_setting(
    'app.user_id', true
  )) AND organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  ))) AND (workspace_id IS NULL OR (CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting(
      'app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
    THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END))
));--> statement-breakpoint

-- stella-migration-safety: reviewed alter-policy - adds the same condition to USING and keeps WITH CHECK unchanged, so it only narrows which rows can be updated; rollback restores the previous USING expression
ALTER POLICY "user_update"
  ON "notifications"
  USING ((
  (user_id =
  (SELECT current_setting(
    'app.user_id', true
  )) AND organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  ))) AND (workspace_id IS NULL OR (CASE
    WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting(
      'app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
    THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END))
))
  WITH CHECK (
    user_id = (SELECT current_setting('app.user_id', true))
    AND organization_id = (SELECT current_setting('app.organization_id', true))
  );
