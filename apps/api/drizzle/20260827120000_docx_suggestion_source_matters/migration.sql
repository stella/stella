SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Record which matters contributed to a persisted DOCX suggestion. Existing
-- rows take the empty array, which the policies below read as "nothing outside
-- this matter fed it" and leave visible exactly as today.
ALTER TABLE "docx_suggestions"
	ADD COLUMN "source_data_workspace_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint

-- stella-migration-safety: reviewed alter-policy - the four ALTER POLICY statements below only AND a further predicate onto the existing workspace check: every matter named in source_data_workspace_ids must also be authorized for the session. No row previously refused becomes visible or writable, and every existing row carries the empty array, for which the added predicate is constant true. Rollback is the reverse ALTER POLICY back to the plain workspace check.
ALTER POLICY "workspace_select" ON "docx_suggestions" USING (
	(CASE
		WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
		THEN true
		ELSE workspace_id IN (
			SELECT aw.authorized_workspace_id
			FROM public.stella_authorized_workspaces aw
		)
	END)
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
);--> statement-breakpoint

-- stella-migration-safety: reviewed alter-policy - insert half of the predicate described above, so a writer can only record contributing matters it is itself authorized for.
ALTER POLICY "workspace_insert" ON "docx_suggestions" WITH CHECK (
	(CASE
		WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
		THEN true
		ELSE workspace_id IN (
			SELECT aw.authorized_workspace_id
			FROM public.stella_authorized_workspaces aw
		)
	END)
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
);--> statement-breakpoint

-- stella-migration-safety: reviewed alter-policy - update half of the same predicate; it narrows which rows a resolve or revert may touch.
ALTER POLICY "workspace_update" ON "docx_suggestions" USING (
	(CASE
		WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
		THEN true
		ELSE workspace_id IN (
			SELECT aw.authorized_workspace_id
			FROM public.stella_authorized_workspaces aw
		)
	END)
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
);--> statement-breakpoint

-- stella-migration-safety: reviewed alter-policy - delete half of the same predicate.
ALTER POLICY "workspace_delete" ON "docx_suggestions" USING (
	(CASE
		WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
		THEN true
		ELSE workspace_id IN (
			SELECT aw.authorized_workspace_id
			FROM public.stella_authorized_workspaces aw
		)
	END)
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
