SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - replaces the deny-all DELETE policy with the tenant and ethical-wall-scoped policy below; rollback recreates ai_memory_no_delete and drops ai_memory_delete.
DROP POLICY "ai_memory_no_delete" ON "ai_memories";
--> statement-breakpoint
CREATE POLICY "ai_memory_delete" ON "ai_memories" AS PERMISSIVE FOR DELETE TO "stella" USING (
	organization_id = (SELECT current_setting('app.organization_id', true))
	AND (
		status <> 'suggested'
		OR created_by = (SELECT current_setting('app.user_id', true))
	)
	AND (
		scope = 'organization'
		OR (scope = 'workspace' AND workspace_id IN (
			SELECT aw.authorized_workspace_id
			FROM public.stella_authorized_workspaces aw
			WHERE aw.workspace_status <> 'deleting'
		))
		OR (scope = 'user' AND user_id = (SELECT current_setting('app.user_id', true)))
	)
	AND (
		cardinality(source_data_workspace_ids) = 0
		OR NOT EXISTS (
			SELECT 1
			FROM pg_catalog.unnest(source_data_workspace_ids) AS scoped_workspace(workspace_id)
			WHERE scoped_workspace.workspace_id IS NULL
				OR NOT (
					scoped_workspace.workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
					OR EXISTS (
						SELECT 1 FROM public.stella_authorized_workspaces aw
						WHERE aw.authorized_workspace_id = scoped_workspace.workspace_id
							AND aw.workspace_status <> 'deleting'
					)
				)
		)
	)
);
