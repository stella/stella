SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
-- stella-migration-safety: reviewed security-definer - fixed search path, PUBLIC execute revoked, read-only; returns the matters one organization member reaches under the existing view rule
CREATE OR REPLACE FUNCTION public.stella_authorized_workspace_ids(
  p_organization_id text,
  p_user_id text
)
RETURNS TABLE (workspace_id uuid, workspace_status text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT w.id, w.status::text
  FROM public.member m
  JOIN public.workspace_members wm
    ON wm.user_id = m.user_id
  JOIN public.workspaces w
    ON w.id = wm.workspace_id
   AND w.organization_id = m.organization_id
  WHERE m.organization_id = p_organization_id
    AND m.user_id = p_user_id
  UNION
  SELECT w.id, w.status::text
  FROM public.member m
  JOIN public.workspaces w
    ON w.organization_id = m.organization_id

  WHERE m.organization_id = p_organization_id
    AND m.user_id = p_user_id
    AND (
      (m.role IN ('owner', 'admin') AND w.visibility IN ('admins_and_assigned', 'all_members'))
      OR (m.role IN ('owner', 'admin', 'member', 'intern') AND w.visibility = 'all_members')
    )
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.stella_authorized_workspace_ids(text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stella_authorized_workspace_ids(text, text) TO stella;--> statement-breakpoint


CREATE OR REPLACE VIEW public.stella_authorized_workspaces
WITH (security_barrier = true, security_invoker = false)
AS
WITH current_member AS (
  SELECT m.organization_id, m.user_id, m.role
  FROM public.member m
  WHERE pg_catalog.current_setting(
      'app.workspace_access_mode',
      true
    ) = 'membership'
    AND m.organization_id = NULLIF(
      pg_catalog.current_setting('app.organization_id', true),
      ''
    )
    AND m.user_id = NULLIF(
      pg_catalog.current_setting('app.user_id', true),
      ''
    )
)
SELECT
  explicit_workspace.workspace_id AS authorized_workspace_id,
  w.status AS workspace_status
FROM pg_catalog.unnest(
  COALESCE(
    NULLIF(
      pg_catalog.current_setting('app.workspace_ids', true),
      ''
    )::uuid[],
    ARRAY[]::uuid[]
  )
) AS explicit_workspace(workspace_id)
LEFT JOIN public.workspaces w
  ON w.id = explicit_workspace.workspace_id
WHERE explicit_workspace.workspace_id IS NOT NULL
UNION ALL
SELECT a.workspace_id AS authorized_workspace_id, a.workspace_status
FROM current_member m
CROSS JOIN LATERAL public.stella_authorized_workspace_ids(m.organization_id, m.user_id) a;
--> statement-breakpoint

--> statement-breakpoint
-- The retained seven-argument creation API delegates to the same lock owner.
-- stella-migration-safety: reviewed security-definer - fixed search path and PUBLIC execute revoked; delegates to the tenant-bound creation procedure without adding authority
CREATE OR REPLACE FUNCTION public.stella_create_workspace(
  p_workspace_id uuid, p_client_id uuid, p_name text, p_reference text,
  p_billing_reference text, p_color text, p_lead_user_id text
) RETURNS void LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT public.stella_create_workspace(
    p_workspace_id, p_client_id, p_name, p_reference, p_billing_reference, p_color,
    CASE WHEN p_client_id IS NULL THEN COALESCE(p_lead_user_id, NULLIF(current_setting('app.user_id', true), '')) ELSE p_lead_user_id END,
    CASE WHEN p_client_id IS NULL THEN 'assigned_only' ELSE 'admins_and_assigned' END
  );
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.stella_create_workspace(uuid, uuid, text, text, text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stella_create_workspace(uuid, uuid, text, text, text, text, text) TO stella;
--> statement-breakpoint
