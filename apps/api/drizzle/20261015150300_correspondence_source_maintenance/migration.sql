-- requires: 20261015150100_data_box_source_gates
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

DO $role$
DECLARE maintenance_role oid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'stella_correspondence_source') THEN
    CREATE ROLE stella_correspondence_source NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  SELECT oid INTO maintenance_role FROM pg_catalog.pg_roles
  WHERE rolname = 'stella_correspondence_source'
    AND NOT (rolcanlogin OR rolinherit OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication);
  IF maintenance_role IS NULL OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = maintenance_role
      OR (roleid = maintenance_role AND (member <> current_user::regrole OR inherit_option OR set_option))
  ) THEN
    RAISE EXCEPTION 'Correspondence source maintenance requires a private non-bypass role';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relowner = maintenance_role)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE proowner = maintenance_role
      AND (pronamespace <> 'public'::regnamespace OR proname NOT IN
        ('next_correspondence_source', 'remove_correspondence_source'))) THEN
    RAISE EXCEPTION 'Correspondence source maintenance may own only its lifecycle routines';
  END IF;
END
$role$;--> statement-breakpoint
-- stella-migration-safety: reviewed grant-privileges - Temporary role administration installs private lifecycle routines; inheritance remains disabled and SET is revoked before commit.
GRANT stella_correspondence_source TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;--> statement-breakpoint
GRANT USAGE, CREATE ON SCHEMA public TO stella_correspondence_source;--> statement-breakpoint
-- Custom scope settings are user-settable; they need no parameter ACL grant.
GRANT SELECT (organization_id, workspace_id, correspondence_id, entity_id) ON public.correspondence_sources TO stella_correspondence_source;--> statement-breakpoint
GRANT SELECT (organization_id, workspace_id, id, source_entity_id), UPDATE (source_entity_id, updated_at), DELETE ON public.correspondence TO stella_correspondence_source;--> statement-breakpoint

CREATE POLICY correspondence_source_maintenance ON public.correspondence_sources
AS PERMISSIVE FOR SELECT TO stella_correspondence_source
USING (organization_id = nullif(current_setting('app.correspondence_source_organization_id', true), '')
  AND workspace_id = nullif(current_setting('app.correspondence_source_workspace_id', true), '')::uuid
  AND correspondence_id = nullif(current_setting('app.correspondence_source_record_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY correspondence_source_maintenance ON public.correspondence
AS PERMISSIVE FOR ALL TO stella_correspondence_source
USING (organization_id = nullif(current_setting('app.correspondence_source_organization_id', true), '')
  AND workspace_id = nullif(current_setting('app.correspondence_source_workspace_id', true), '')::uuid
  AND id = nullif(current_setting('app.correspondence_source_record_id', true), '')::uuid)
WITH CHECK (organization_id = nullif(current_setting('app.correspondence_source_organization_id', true), '')
  AND workspace_id = nullif(current_setting('app.correspondence_source_workspace_id', true), '')::uuid
  AND id = nullif(current_setting('app.correspondence_source_record_id', true), '')::uuid);--> statement-breakpoint

-- stella-migration-safety: reviewed change-owner - Only the source lifecycle trigger moves to a non-login, non-bypass role with row-scoped policies; application execution stays revoked.
ALTER FUNCTION public.remove_correspondence_source() OWNER TO stella_correspondence_source;--> statement-breakpoint
SET LOCAL ROLE stella_correspondence_source;--> statement-breakpoint
CREATE FUNCTION public.next_correspondence_source(deleted_source public.correspondence_sources)
RETURNS uuid LANGUAGE sql SET search_path = pg_catalog SET row_security = on AS $$
  SELECT entity_id FROM public.correspondence_sources
  WHERE organization_id = (deleted_source).organization_id
    AND workspace_id = (deleted_source).workspace_id
    AND correspondence_id = (deleted_source).correspondence_id
  ORDER BY entity_id LIMIT 1
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.next_correspondence_source(public.correspondence_sources) FROM PUBLIC;--> statement-breakpoint

-- stella-migration-safety: reviewed security-definer - Private non-bypass role, fixed search path and forced row security; scope comes only from the deleted source row and is restored at function exit.
CREATE OR REPLACE FUNCTION public.remove_correspondence_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog SET row_security = on
SET app.correspondence_source_organization_id = ''
SET app.correspondence_source_workspace_id = ''
SET app.correspondence_source_record_id = '' AS $$
DECLARE next_source uuid;
BEGIN
  PERFORM set_config('app.correspondence_source_organization_id', OLD.organization_id, true),
    set_config('app.correspondence_source_workspace_id', OLD.workspace_id::text, true),
    set_config('app.correspondence_source_record_id', OLD.correspondence_id::text, true);
  PERFORM 1 FROM public.correspondence
  WHERE organization_id = OLD.organization_id
    AND workspace_id = OLD.workspace_id AND id = OLD.correspondence_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN OLD;
  END IF;
  next_source := public.next_correspondence_source(OLD);
  IF next_source IS NULL THEN
    DELETE FROM public.correspondence
    WHERE organization_id = OLD.organization_id
      AND workspace_id = OLD.workspace_id AND id = OLD.correspondence_id;
  ELSE
    UPDATE public.correspondence
    SET source_entity_id = next_source, updated_at = now()
    WHERE organization_id = OLD.organization_id
      AND workspace_id = OLD.workspace_id AND id = OLD.correspondence_id
      AND source_entity_id = OLD.entity_id;
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.remove_correspondence_source() FROM PUBLIC;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM stella_correspondence_source;--> statement-breakpoint
-- stella-migration-safety: reviewed grant-privileges - Disable runtime switching to the private lifecycle role after installing its trigger-only entry point.
GRANT stella_correspondence_source TO CURRENT_USER WITH SET FALSE;
