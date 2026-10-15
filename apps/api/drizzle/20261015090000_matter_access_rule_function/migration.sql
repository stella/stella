SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- The matter access rule as functions with explicit arguments, so app code
-- asks the database instead of computing the rule again. The rule is the one
-- stella_authorized_workspaces applies in membership mode: a matter
-- assignment, or an owner or admin role on a client matter, always within the
-- member's organization. The view and the row policies are rebuilt on this
-- function by a later migration, once every API task calls it.

-- stella-migration-safety: reviewed security-definer - fixed search path, PUBLIC execute revoked, read-only; returns the matters one organization member reaches under the existing view rule
CREATE FUNCTION public.stella_authorized_workspace_ids(
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
   AND w.client_id IS NOT NULL
  WHERE m.organization_id = p_organization_id
    AND m.user_id = p_user_id
    AND m.role IN ('owner', 'admin')
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.stella_authorized_workspace_ids(text, text) FROM PUBLIC;--> statement-breakpoint
-- stella-migration-safety: reviewed grant-privileges - the application role may ask which matters a member reaches; the function only reads
GRANT EXECUTE ON FUNCTION public.stella_authorized_workspace_ids(text, text) TO stella;--> statement-breakpoint

-- One matter, derived from the set above so the rule is written once.
CREATE FUNCTION public.stella_workspace_access(
  p_organization_id text,
  p_user_id text,
  p_workspace_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.stella_authorized_workspace_ids(p_organization_id, p_user_id) a
    WHERE a.workspace_id = p_workspace_id
  )
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.stella_workspace_access(text, text, uuid) FROM PUBLIC;--> statement-breakpoint
-- stella-migration-safety: reviewed grant-privileges - the application role may ask whether a member reaches one matter; the function only reads
GRANT EXECUTE ON FUNCTION public.stella_workspace_access(text, text, uuid) TO stella;--> statement-breakpoint

-- Creating a matter: inserts the matter in the transaction's organization and,
-- when the creating member would not reach it otherwise, that member's
-- assignment, so the new matter is reachable through the rule above without
-- naming it in app.workspace_ids. It adds no other member.
-- stella-migration-safety: reviewed security-definer - fixed search path, PUBLIC execute revoked; organization and user come from the transaction settings, never from arguments; inserts one matter and at most the caller's own assignment
CREATE FUNCTION public.stella_create_workspace(
  p_workspace_id uuid,
  p_client_id uuid,
  p_name text,
  p_reference text,
  p_billing_reference text,
  p_color text,
  p_lead_user_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_organization_id text := NULLIF(
    pg_catalog.current_setting('app.organization_id', true),
    ''
  );
  v_user_id text := NULLIF(pg_catalog.current_setting('app.user_id', true), '');
BEGIN
  IF v_organization_id IS NULL OR v_user_id IS NULL THEN
    RAISE EXCEPTION 'creating a matter requires an organization member'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.member m
    WHERE m.organization_id = v_organization_id
      AND m.user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'creating a matter requires an organization member'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The function runs as the owner, so it checks what the row policies would:
  -- the client and the lead belong to the same organization.
  IF p_client_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.contacts c
    WHERE c.id = p_client_id
      AND c.organization_id = v_organization_id
  ) THEN
    RAISE EXCEPTION 'the client belongs to another organization'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF p_lead_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.member m
    WHERE m.organization_id = v_organization_id
      AND m.user_id = p_lead_user_id
  ) THEN
    RAISE EXCEPTION 'the matter lead is not an organization member'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  INSERT INTO public.workspaces (
    id,
    organization_id,
    client_id,
    name,
    reference,
    billing_reference,
    color,
    lead_user_id
  )
  VALUES (
    p_workspace_id,
    v_organization_id,
    p_client_id,
    p_name,
    p_reference,
    p_billing_reference,
    p_color,
    p_lead_user_id
  );

  IF NOT public.stella_workspace_access(
    v_organization_id,
    v_user_id,
    p_workspace_id
  ) THEN
    -- The application mints ids for its own inserts; the column has no
    -- database default, so the function supplies one.
    INSERT INTO public.workspace_members (id, workspace_id, user_id)
    VALUES (pg_catalog.gen_random_uuid(), p_workspace_id, v_user_id);
  END IF;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.stella_create_workspace(uuid, uuid, text, text, text, text, text) FROM PUBLIC;--> statement-breakpoint
-- stella-migration-safety: reviewed grant-privileges - the application role creates matters through this function; it binds organization and user to the transaction settings
GRANT EXECUTE ON FUNCTION public.stella_create_workspace(uuid, uuid, text, text, text, text, text) TO stella;
