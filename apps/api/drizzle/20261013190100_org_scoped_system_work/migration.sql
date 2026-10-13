SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stella_system') THEN
    CREATE ROLE stella_system NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
  ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stella_system' AND (rolsuper OR rolbypassrls OR rolcanlogin OR rolinherit OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN
    RAISE EXCEPTION 'System scope role requires its declared posture';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members membership
    JOIN pg_roles scoped_role ON scoped_role.oid = membership.member
    WHERE scoped_role.rolname = 'stella_system' AND membership.inherit_option) THEN
    RAISE EXCEPTION 'System scope role requires independent permissions';
  END IF;
END;
$role$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO stella_system;
--> statement-breakpoint
-- stella-migration-safety: reviewed grant-privileges - The login may select a NOLOGIN, NOBYPASSRLS organization-scoped system role for row-proven owner work.
GRANT stella_system TO CURRENT_USER WITH SET TRUE, INHERIT FALSE;
--> statement-breakpoint
DO $policies$
DECLARE
  target record;
  org_expression text;
  matter_expression text;
  scope_expression text;
  command text;
BEGIN
  FOR target IN SELECT * FROM (VALUES
      ('organization', 'read'), ('member', 'read'),
      ('contacts', 'write'), ('workspaces', 'write'), ('workspace_members', 'write'),
      ('entities', 'write'), ('entity_versions', 'write'), ('fields', 'write'),
      ('task_assignees', 'write'), ('desktop_edit_sessions', 'write'), ('desktop_edit_handoffs', 'write'),
      ('flow_definitions', 'write'), ('flow_runs', 'write'), ('flow_run_steps', 'write'),
      ('flow_upload_trigger_intents', 'write'), ('signals', 'write'), ('signal_events', 'write'),
      ('scout_runs', 'write'), ('pending_scout_emissions', 'write'), ('document_processing_runs', 'write'),
      ('document_review_runs', 'write'), ('document_review_findings', 'read'), ('notifications', 'write'),
      ('work_obligations', 'write'), ('feature_enrolments', 'read'), ('pdf_signing_sessions', 'write'),
      ('work_obligation_events', 'write'), ('time_entries', 'write'), ('search_projection_repair_queue', 'write'),
      ('search_history_entries', 'write'), ('search_history_owners', 'write'), ('search_history_tombstones', 'write'),
      ('mcp_user_connections', 'write'), ('mcp_oauth_state', 'write'),
      ('sharepoint_connections', 'write'), ('sharepoint_oauth_state', 'write'), ('invitation', 'write')
    ) AS owned(table_name, access_mode)
  LOOP
    IF target.table_name = 'organization' THEN
      org_expression := 'id';
    ELSIF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = target.table_name AND column_name = 'organization_id') THEN
      org_expression := 'organization_id';
    ELSIF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = target.table_name AND column_name = 'workspace_id') THEN
      org_expression := '(SELECT scope_workspace.organization_id FROM public.workspaces scope_workspace WHERE scope_workspace.id = workspace_id)';
    ELSE
      RAISE EXCEPTION 'System scope requires organization ownership for %', target.table_name;
    END IF;
    IF target.table_name = 'signal_events' THEN
      matter_expression := 'EXISTS (SELECT 1 FROM public.signals scope_signal WHERE scope_signal.id = signal_id)';
    ELSIF target.table_name = 'workspaces' THEN
      matter_expression := '(id IS NULL OR id = ANY(coalesce(nullif(current_setting(''app.workspace_ids'', true), '''')::uuid[], ''{}'')))';
    ELSIF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = target.table_name AND column_name = 'workspace_id') THEN
      matter_expression := '(workspace_id IS NULL OR workspace_id = ANY(coalesce(nullif(current_setting(''app.workspace_ids'', true), '''')::uuid[], ''{}'')))';
    ELSE
      matter_expression := 'true';
    END IF;
    scope_expression := format('%s = nullif(current_setting(''app.organization_id'', true), '''') AND %s', org_expression, matter_expression);
    IF target.access_mode = 'read' THEN
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO stella_system', target.table_name);
      command := format('CREATE POLICY organization_system_access ON public.%I FOR SELECT TO stella_system USING (%s)', target.table_name, scope_expression);
    ELSE
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO stella_system', target.table_name);
      command := format('CREATE POLICY organization_system_access ON public.%I FOR ALL TO stella_system USING (%s) WITH CHECK (%s)', target.table_name, scope_expression, scope_expression);
    END IF;
    EXECUTE command;
    EXECUTE format('CREATE POLICY organization_system_scope ON public.%I AS RESTRICTIVE FOR ALL TO stella_system USING (%s) WITH CHECK (%s)', target.table_name, scope_expression, scope_expression);
  END LOOP;
END;
$policies$;
--> statement-breakpoint
GRANT SELECT ON TABLE public."user" TO stella_system;
--> statement-breakpoint
CREATE POLICY user_system_select ON public."user" FOR SELECT TO stella_system USING (
  EXISTS (SELECT 1 FROM public.member scope_member WHERE scope_member.user_id = "user".id
    AND scope_member.organization_id = nullif(current_setting('app.organization_id', true), ''))
);
--> statement-breakpoint
ALTER TABLE pending_scout_emissions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Replaces the receipt owner policy with discovery access and scoped mutation policies.
DROP POLICY pending_scout_emissions_owner_access ON pending_scout_emissions;
--> statement-breakpoint
CREATE POLICY pending_scout_emissions_owner_access ON pending_scout_emissions FOR SELECT TO public USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.pending_scout_emissions'::regclass)
);
--> statement-breakpoint
ALTER TABLE flow_upload_trigger_intents FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Replaces the receipt owner policy with discovery access and scoped mutation policies.
DROP POLICY flow_upload_trigger_intents_owner_access ON flow_upload_trigger_intents;
--> statement-breakpoint
CREATE POLICY flow_upload_trigger_intents_owner_access ON flow_upload_trigger_intents FOR SELECT TO public USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.flow_upload_trigger_intents'::regclass)
);

--> statement-breakpoint
-- Discovery locks require UPDATE visibility; the row check refuses owner mutations.
CREATE POLICY pending_scout_emissions_owner_lock ON pending_scout_emissions FOR UPDATE TO public USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.pending_scout_emissions'::regclass)
) WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY flow_upload_trigger_intents_owner_lock ON flow_upload_trigger_intents FOR UPDATE TO public USING (
  current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.flow_upload_trigger_intents'::regclass)
) WITH CHECK (false);
