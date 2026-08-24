SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER POLICY "workspace_select" ON "work_obligations" USING (CASE
  WHEN "workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
  THEN true
  ELSE "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
END);--> statement-breakpoint
ALTER POLICY "workspace_insert" ON "work_obligations" WITH CHECK (CASE
  WHEN "workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
  THEN true
  ELSE "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
END);--> statement-breakpoint
ALTER POLICY "workspace_update" ON "work_obligations" USING (CASE
  WHEN "workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
  THEN true
  ELSE "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
END);--> statement-breakpoint
ALTER POLICY "workspace_delete" ON "work_obligations" USING (CASE
  WHEN "workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
  THEN true
  ELSE "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
END);--> statement-breakpoint
ALTER POLICY "work_obligation_events_select" ON "work_obligation_events" USING (CASE
  WHEN "workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
  THEN true
  ELSE "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
END);--> statement-breakpoint
ALTER POLICY "work_obligation_events_insert" ON "work_obligation_events" WITH CHECK (CASE
  WHEN "workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
  THEN true
  ELSE "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
END);
