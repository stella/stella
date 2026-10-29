-- requires: 20261029074300_data_box_source_gates
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
        ('next_correspondence_source', 'remove_correspondence_source', 'remove_entity_correspondence_sources'))) THEN
    RAISE EXCEPTION 'Correspondence source maintenance may own only its lifecycle routines';
  END IF;
END
$role$;--> statement-breakpoint
-- stella-migration-safety: reviewed grant-privileges - Temporary role administration installs private lifecycle routines; inheritance remains disabled and SET is revoked before commit.
GRANT stella_correspondence_source TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;--> statement-breakpoint
GRANT USAGE, CREATE ON SCHEMA public TO stella_correspondence_source;--> statement-breakpoint
GRANT SELECT (organization_id, workspace_id, correspondence_id, entity_id) ON public.correspondence_sources TO stella_correspondence_source;--> statement-breakpoint
GRANT DELETE ON public.correspondence_sources TO stella_correspondence_source;--> statement-breakpoint
GRANT SELECT (organization_id, workspace_id, id, source_entity_id), UPDATE (source_entity_id, updated_at), DELETE ON public.correspondence TO stella_correspondence_source;--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.stella_authorized_workspace_ids(text, text) TO stella_correspondence_source;--> statement-breakpoint
GRANT SELECT (entity_feature_gate) ON public.correspondence_sources, public.correspondence TO stella_correspondence_source;--> statement-breakpoint

-- Entity deletion is authorized on the parent row. Its trigger scopes cleanup
-- from OLD, including when a workspace cascade has already removed the workspace.
CREATE POLICY correspondence_source_entity_maintenance ON public.correspondence_sources
AS PERMISSIVE FOR ALL TO stella_correspondence_source
USING (workspace_id = nullif(current_setting('app.correspondence_source_workspace_id', true), '')::uuid
  AND entity_id = nullif(current_setting('app.correspondence_source_entity_id', true), '')::uuid)
WITH CHECK (false);--> statement-breakpoint
CREATE POLICY correspondence_source_entity_maintenance ON public.correspondence
AS PERMISSIVE FOR ALL TO stella_correspondence_source
USING (workspace_id = nullif(current_setting('app.correspondence_source_workspace_id', true), '')::uuid
  AND source_entity_id = nullif(current_setting('app.correspondence_source_entity_id', true), '')::uuid)
WITH CHECK (false);--> statement-breakpoint

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
-- stella-migration-safety: reviewed change-owner - The entity deletion trigger uses only its trusted OLD row to unlink that source, without depending on caller visibility of correspondence.
ALTER FUNCTION public.remove_entity_correspondence_sources() OWNER TO stella_correspondence_source;--> statement-breakpoint
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

-- stella-migration-safety: reviewed security-definer - returns one boolean for a source the caller can see in an active authorized workspace of its own organization (NULL when not admitted), never ids, counts or content; fixed search_path, row security on, session settings restored, PUBLIC revoked and EXECUTE only to stella; rollback: drop the function with the migration
CREATE FUNCTION public.correspondence_has_other_sources(p_workspace_id uuid, p_entity_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog SET row_security = on AS $$
DECLARE
  caller_organization text := nullif(current_setting('app.organization_id', true), '');
  caller_user text := nullif(current_setting('app.user_id', true), '');
  enabled_features jsonb := coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb;
  source_record_id uuid;
  has_others boolean;
  previous_organization text := current_setting('app.correspondence_source_organization_id', true);
  previous_workspace text := current_setting('app.correspondence_source_workspace_id', true);
  previous_record text := current_setting('app.correspondence_source_record_id', true);
  previous_entity text := current_setting('app.correspondence_source_entity_id', true);
BEGIN
  IF p_workspace_id IS NULL OR p_entity_id IS NULL OR caller_organization IS NULL OR caller_user IS NULL
    OR NOT EXISTS (SELECT 1 FROM public.stella_authorized_workspace_ids(caller_organization, caller_user)
      WHERE workspace_id = p_workspace_id AND workspace_status = 'active') THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('app.correspondence_source_organization_id', '', true),
    set_config('app.correspondence_source_workspace_id', p_workspace_id::text, true),
    set_config('app.correspondence_source_record_id', '', true),
    set_config('app.correspondence_source_entity_id', p_entity_id::text, true);
  -- Admit only the caller-visible source (or its unenrolled legacy pointer).
  SELECT candidate.record_id INTO source_record_id FROM (
    SELECT s.correspondence_id AS record_id, s.entity_feature_gate, 0 AS priority
    FROM public.correspondence_sources s
    WHERE s.organization_id = caller_organization AND s.workspace_id = p_workspace_id AND s.entity_id = p_entity_id
    UNION ALL
    SELECT c.id, c.entity_feature_gate, 1
    FROM public.correspondence c
    WHERE c.organization_id = caller_organization AND c.workspace_id = p_workspace_id AND c.source_entity_id = p_entity_id
  ) candidate
  WHERE candidate.entity_feature_gate = 'open'
    OR (candidate.entity_feature_gate = 'legal-lists' AND enabled_features ? 'legal-lists')
  ORDER BY candidate.priority LIMIT 1;
  IF source_record_id IS NOT NULL THEN
    PERFORM set_config('app.correspondence_source_organization_id', caller_organization, true),
      set_config('app.correspondence_source_record_id', source_record_id::text, true),
      set_config('app.correspondence_source_entity_id', '', true);
    SELECT EXISTS (
      SELECT 1 FROM public.correspondence_sources s
      WHERE s.organization_id = caller_organization AND s.workspace_id = p_workspace_id
        AND s.correspondence_id = source_record_id AND s.entity_id <> p_entity_id
    ) INTO has_others;
  END IF;
  PERFORM set_config('app.correspondence_source_organization_id', coalesce(previous_organization, ''), true),
    set_config('app.correspondence_source_workspace_id', coalesce(previous_workspace, ''), true),
    set_config('app.correspondence_source_record_id', coalesce(previous_record, ''), true),
    set_config('app.correspondence_source_entity_id', coalesce(previous_entity, ''), true);
  -- NULL means the visible source was not admitted, never "no survivors".
  RETURN has_others;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.correspondence_has_other_sources(uuid, uuid) FROM PUBLIC;--> statement-breakpoint

-- stella-migration-safety: reviewed security-definer - Private non-bypass role, fixed search path and forced row security; scope comes only from the deleted source row and is restored before returning.
CREATE OR REPLACE FUNCTION public.remove_correspondence_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog SET row_security = on AS $$
DECLARE
  next_source uuid;
  previous_organization_id text := current_setting('app.correspondence_source_organization_id', true);
  previous_workspace_id text := current_setting('app.correspondence_source_workspace_id', true);
  previous_record_id text := current_setting('app.correspondence_source_record_id', true);
  previous_entity_id text := current_setting('app.correspondence_source_entity_id', true);
BEGIN
  PERFORM set_config('app.correspondence_source_organization_id', OLD.organization_id, true),
    set_config('app.correspondence_source_workspace_id', OLD.workspace_id::text, true),
    set_config('app.correspondence_source_record_id', OLD.correspondence_id::text, true),
    set_config('app.correspondence_source_entity_id', '', true);
  PERFORM 1 FROM public.correspondence
  WHERE organization_id = OLD.organization_id
    AND workspace_id = OLD.workspace_id AND id = OLD.correspondence_id
  FOR UPDATE;
  IF FOUND THEN
    next_source := public.next_correspondence_source(OLD);
    IF next_source IS NOT NULL THEN
      UPDATE public.correspondence
      SET source_entity_id = next_source, updated_at = now()
      WHERE organization_id = OLD.organization_id
        AND workspace_id = OLD.workspace_id AND id = OLD.correspondence_id
        AND source_entity_id = OLD.entity_id;
    END IF;
  END IF;
  -- Custom GUCs cannot appear in this owner's function SET clauses. Restore
  -- successful calls explicitly; a failed statement rolls back its local GUCs.
  PERFORM set_config('app.correspondence_source_organization_id', coalesce(previous_organization_id, ''), true),
    set_config('app.correspondence_source_workspace_id', coalesce(previous_workspace_id, ''), true),
    set_config('app.correspondence_source_record_id', coalesce(previous_record_id, ''), true),
    set_config('app.correspondence_source_entity_id', coalesce(previous_entity_id, ''), true);
  RETURN OLD;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.remove_correspondence_source() FROM PUBLIC;--> statement-breakpoint

-- stella-migration-safety: reviewed security-definer - The private role can only select/delete rows linked to the exact OLD entity and matter; nested record maintenance saves and restores this scope.
CREATE OR REPLACE FUNCTION public.remove_entity_correspondence_sources() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog SET row_security = on AS $$
DECLARE
  previous_organization_id text := current_setting('app.correspondence_source_organization_id', true);
  previous_workspace_id text := current_setting('app.correspondence_source_workspace_id', true);
  previous_record_id text := current_setting('app.correspondence_source_record_id', true);
  previous_entity_id text := current_setting('app.correspondence_source_entity_id', true);
BEGIN
  PERFORM set_config('app.correspondence_source_organization_id', '', true),
    set_config('app.correspondence_source_workspace_id', OLD.workspace_id::text, true),
    set_config('app.correspondence_source_record_id', '', true),
    set_config('app.correspondence_source_entity_id', OLD.id::text, true);
  DELETE FROM public.correspondence_sources
  WHERE workspace_id = OLD.workspace_id AND entity_id = OLD.id;
  -- Surviving copies have already repointed their record in the nested trigger.
  -- A final source (including an unenrolled legacy pointer) still names this
  -- deleted document. This entity trigger exclusively owns record deletion.
  DELETE FROM public.correspondence
  WHERE workspace_id = OLD.workspace_id AND source_entity_id = OLD.id;
  PERFORM set_config('app.correspondence_source_organization_id', coalesce(previous_organization_id, ''), true),
    set_config('app.correspondence_source_workspace_id', coalesce(previous_workspace_id, ''), true),
    set_config('app.correspondence_source_record_id', coalesce(previous_record_id, ''), true),
    set_config('app.correspondence_source_entity_id', coalesce(previous_entity_id, ''), true);
  RETURN OLD;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.remove_entity_correspondence_sources() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.correspondence_has_other_sources(uuid, uuid) TO stella;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM stella_correspondence_source;--> statement-breakpoint
-- stella-migration-safety: reviewed grant-privileges - Disable runtime switching to the private lifecycle role after installing its trigger-only entry point.
GRANT stella_correspondence_source TO CURRENT_USER WITH SET FALSE;--> statement-breakpoint

-- Tenant routines remain available to the application without granting them
-- to every private maintenance or public-corpus role through PUBLIC.
REVOKE EXECUTE ON FUNCTION public.delete_service_oauth_client_credential() FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.legal_reader_annotation_claim_held(uuid, uuid, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.legal_reader_annotation_claim_held(uuid, uuid, uuid) TO stella;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.legal_reader_annotation_claim_visible(uuid, uuid, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.legal_reader_annotation_claim_visible(uuid, uuid, uuid) TO stella;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.legal_reader_annotation_document_held(uuid, uuid, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.legal_reader_annotation_document_held(uuid, uuid, uuid) TO stella;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.legal_reader_annotation_document_visible(uuid, uuid, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.legal_reader_annotation_document_visible(uuid, uuid, uuid) TO stella;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.mark_sanctions_contact_insert() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mark_sanctions_contact_insert() TO stella;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.mark_sanctions_contact_update() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mark_sanctions_contact_update() TO stella;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.mark_sanctions_organization_insert() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mark_sanctions_organization_insert() TO stella;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.mark_sanctions_organization_update() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mark_sanctions_organization_update() TO stella;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.register_uploaded_correspondence_source() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.register_uploaded_correspondence_source() TO stella;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.stella_entity_display_name(text, text, uuid, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stella_entity_display_name(text, text, uuid, uuid) TO stella;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.stella_refresh_entity_display_name(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stella_refresh_entity_display_name(uuid) TO stella;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.stella_refresh_entity_display_name_from_entity() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stella_refresh_entity_display_name_from_entity() TO stella;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.stella_refresh_entity_display_name_from_field() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stella_refresh_entity_display_name_from_field() TO stella;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.sync_time_entry_timer_state() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.sync_time_entry_timer_state() TO stella;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.user_files_enforce_organization_key() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.user_files_enforce_organization_key() TO stella;--> statement-breakpoint

-- Preserve execution for every existing table or column privilege holder,
-- including built-in data roles, after replacing PUBLIC access with named grants.
GRANT EXECUTE ON FUNCTION public.delete_service_oauth_client_credential() TO pg_maintain, pg_read_all_data, pg_write_all_data;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.legal_reader_annotation_claim_held(uuid,uuid,uuid) TO pg_maintain, pg_read_all_data, pg_write_all_data;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.legal_reader_annotation_claim_visible(uuid,uuid,uuid) TO pg_maintain, pg_read_all_data, pg_write_all_data;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.legal_reader_annotation_document_held(uuid,uuid,uuid) TO pg_maintain, pg_read_all_data, pg_write_all_data;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.legal_reader_annotation_document_visible(uuid,uuid,uuid) TO pg_maintain, pg_read_all_data, pg_write_all_data;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mark_sanctions_contact_insert() TO pg_maintain, pg_read_all_data, pg_write_all_data;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mark_sanctions_contact_update() TO pg_maintain, pg_read_all_data, pg_write_all_data;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mark_sanctions_organization_insert() TO pg_maintain, pg_read_all_data, pg_write_all_data;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mark_sanctions_organization_update() TO pg_maintain, pg_read_all_data, pg_write_all_data;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.register_uploaded_correspondence_source() TO pg_maintain, pg_read_all_data, pg_write_all_data, stella_correspondence_source, stella_entity_gate;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stella_entity_display_name(text,text,uuid,uuid) TO pg_maintain, pg_read_all_data, pg_write_all_data, stella_entity_gate;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stella_refresh_entity_display_name(uuid) TO pg_maintain, pg_read_all_data, pg_write_all_data, stella_entity_gate;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stella_refresh_entity_display_name_from_entity() TO pg_maintain, pg_read_all_data, pg_write_all_data, stella_entity_gate;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stella_refresh_entity_display_name_from_field() TO pg_maintain, pg_read_all_data, pg_write_all_data, stella_entity_gate;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.sync_time_entry_timer_state() TO pg_maintain, pg_read_all_data, pg_write_all_data;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.user_files_enforce_organization_key() TO pg_maintain, pg_read_all_data, pg_write_all_data;--> statement-breakpoint
