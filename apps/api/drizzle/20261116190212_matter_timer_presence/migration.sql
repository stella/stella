SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Like invoice_lines_owner_select, permit aggregate definer reads under FORCE RLS.
-- Request-role row visibility and owner write policies stay unchanged.
CREATE POLICY time_timers_owner_select ON public.time_timers FOR SELECT TO PUBLIC
USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.time_timers'::regclass));--> statement-breakpoint

-- stella-migration-safety: reviewed security-definer - Boolean presence only for a live member with matter-update authority and canonical matter access in the session organization; owner-only SELECT reads hidden timers, PUBLIC execute is revoked, and the search path is fixed.
CREATE FUNCTION public.stella_matter_has_running_timers(p_workspace_id uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  caller_organization text := NULLIF(pg_catalog.current_setting('app.organization_id', true), '');
  caller_user text := NULLIF(pg_catalog.current_setting('app.user_id', true), '');
  -- Immutable snapshot bound to roleAllows(workspace:update) by the owning contract test.
  allowed_workspace_update_roles constant text[] := ARRAY['owner', 'admin', 'member'];
  authorized boolean;
BEGIN
  IF p_workspace_id IS NULL OR caller_organization IS NULL OR caller_user IS NULL THEN
    RAISE EXCEPTION 'Matter timer presence access denied' USING ERRCODE = '42501';
  END IF;

  SELECT m.role = ANY(allowed_workspace_update_roles)
    AND public.stella_workspace_access(caller_organization, caller_user, p_workspace_id) IS TRUE
  INTO authorized
  FROM public.member m
  WHERE m.organization_id = caller_organization AND m.user_id = caller_user;
  IF authorized IS NOT TRUE THEN
    RAISE EXCEPTION 'Matter timer presence access denied' USING ERRCODE = '42501';
  END IF;

  -- Reentrant for archive. Recheck current authority with a fresh statement after any wait.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_workspace_id::text));
  SELECT m.role = ANY(allowed_workspace_update_roles)
    AND public.stella_workspace_access(caller_organization, caller_user, p_workspace_id) IS TRUE
  INTO authorized
  FROM public.member m
  WHERE m.organization_id = caller_organization AND m.user_id = caller_user;
  IF authorized IS NOT TRUE THEN
    RAISE EXCEPTION 'Matter timer presence access denied' USING ERRCODE = '42501';
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.time_timers timer
    WHERE timer.organization_id = caller_organization
      AND timer.workspace_id = p_workspace_id
      AND timer.state = 'running'
  );
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.stella_matter_has_running_timers(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stella_matter_has_running_timers(uuid) TO stella;
