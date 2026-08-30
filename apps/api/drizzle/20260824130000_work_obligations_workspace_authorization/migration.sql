SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- stella-migration-safety: reviewed alter-policy - this narrows work-obligation reads to the same live workspace authorization set already enforced by handlers and RLS on the owning workspace. Rollback is a forward ALTER POLICY restoring the previous workspace-array predicate.
ALTER POLICY "workspace_select" ON "work_obligations" USING (CASE
  WHEN "workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
  THEN true
  ELSE "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
END);--> statement-breakpoint
-- stella-migration-safety: reviewed alter-policy - inserts remain workspace-scoped and now accept membership-derived authorization in addition to explicit transaction pins; no organization boundary changes. Rollback is the forward policy restoration described above.
ALTER POLICY "workspace_insert" ON "work_obligations" WITH CHECK (CASE
  WHEN "workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
  THEN true
  ELSE "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
END);--> statement-breakpoint
-- stella-migration-safety: reviewed alter-policy - updates use the same owner-evaluated authorized-workspace view as reads, preserving matter isolation while supporting membership mode. Rollback is the forward policy restoration described above.
ALTER POLICY "workspace_update" ON "work_obligations" USING (CASE
  WHEN "workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
  THEN true
  ELSE "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
END);--> statement-breakpoint
-- stella-migration-safety: reviewed alter-policy - deletes remain limited to authorized matters; root teardown paths do not use the stella role. Rollback is the forward policy restoration described above.
ALTER POLICY "workspace_delete" ON "work_obligations" USING (CASE
  WHEN "workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
  THEN true
  ELSE "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
END);--> statement-breakpoint
-- stella-migration-safety: reviewed alter-policy - event reads adopt the owning obligation's workspace authorization mechanism without widening organization scope. Rollback is a forward ALTER POLICY restoring the previous workspace-array predicate.
ALTER POLICY "work_obligation_events_select" ON "work_obligation_events" USING (CASE
  WHEN "workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
  THEN true
  ELSE "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
END);--> statement-breakpoint
-- stella-migration-safety: reviewed alter-policy - event inserts remain pinned to an authorized matter and only replace the explicit-array lookup with the canonical membership-aware authorization view. Rollback is the forward policy restoration described above.
ALTER POLICY "work_obligation_events_insert" ON "work_obligation_events" WITH CHECK (CASE
  WHEN "workspace_id" = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
  THEN true
  ELSE "workspace_id" IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
END);
