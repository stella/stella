-- requires: 20261031011514_matter_visibility
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Creating a matter: inserts the matter in the transaction's organization and,
-- when the creating member would not reach it otherwise, that member's
-- assignment, so the new matter is reachable through the rule above without
-- naming it in app.workspace_ids. It adds no other member.
-- stella-migration-safety: reviewed security-definer - fixed search path, PUBLIC execute revoked; organization and user come from the transaction settings, never from arguments; inserts one matter and at most the caller's own assignment
CREATE OR REPLACE FUNCTION public.stella_create_workspace(
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
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_organization_id text := NULLIF(
    pg_catalog.current_setting('app.organization_id', true),
    ''
  );
  v_user_id text := NULLIF(pg_catalog.current_setting('app.user_id', true), '');
  v_visibility text := CASE WHEN p_client_id IS NULL THEN 'assigned_only' ELSE 'admins_and_assigned' END;
  v_lead_user_id text;
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

  v_lead_user_id := CASE WHEN p_client_id IS NULL THEN COALESCE(p_lead_user_id, v_user_id) ELSE p_lead_user_id END;
  PERFORM public.stella_lock_matter_stewardship(pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'organization_id', v_organization_id, 'workspace_ids', ARRAY[p_workspace_id],
    'user_ids', pg_catalog.array_remove(ARRAY[v_user_id, v_lead_user_id], NULL)
  )), 'update');

  INSERT INTO public.workspaces (
    id,
    organization_id,
    client_id,
    name,
    reference,
    billing_reference,
    color,
    lead_user_id,
    visibility
  )
  VALUES (
    p_workspace_id,
    v_organization_id,
    p_client_id,
    p_name,
    p_reference,
    p_billing_reference,
    p_color,
    v_lead_user_id,
    v_visibility
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
GRANT EXECUTE ON FUNCTION public.stella_create_workspace(uuid, uuid, text, text, text, text, text) TO stella;
