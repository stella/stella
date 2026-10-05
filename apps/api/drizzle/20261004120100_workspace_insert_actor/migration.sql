-- requires: 20260710173000_scalable_workspace_authorization
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- stella-migration-safety: reviewed alter-policy - Retains organization scope and supports authenticated users and existing explicit service scopes; a forward policy migration can restore the prior condition if needed.
ALTER POLICY "workspace_insert" ON "workspaces" WITH CHECK (
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND (
    NULLIF((SELECT pg_catalog.current_setting('app.user_id', true)), '') IS NOT NULL
    OR (SELECT pg_catalog.current_setting('app.workspace_access_mode', true)) = 'explicit'
  )
);--> statement-breakpoint
