SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint
CREATE ROLE stella_system NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO stella_system;
--> statement-breakpoint
GRANT SELECT ON TABLE
  public."organization", public."member", public."document_review_findings", public."feature_enrolments"
TO stella_system;
--> statement-breakpoint
-- Contact writes fire the invoker-rights sanctions mark upsert triggers, so the
-- marks table is written whenever contacts are.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public."contacts", public."workspaces", public."workspace_members", public."entities",
  public."entity_versions", public."fields", public."task_assignees", public."desktop_edit_sessions",
  public."desktop_edit_handoffs", public."flow_definitions", public."flow_runs", public."flow_run_steps",
  public."flow_upload_trigger_intents", public."signals", public."signal_events", public."scout_runs",
  public."pending_scout_emissions", public."document_processing_runs", public."document_review_runs", public."notifications",
  public."work_obligations", public."pdf_signing_sessions", public."work_obligation_events", public."time_entries",
  public."search_projection_repair_queue", public."search_history_entries", public."search_history_owners", public."search_history_tombstones",
  public."mcp_user_connections", public."mcp_oauth_state", public."sharepoint_connections", public."sharepoint_oauth_state",
  public."invitation", public."sanctions_contact_marks"
TO stella_system;
--> statement-breakpoint
-- stella-migration-safety: reviewed grant-privileges - The login may select a NOLOGIN, NOBYPASSRLS organization-scoped system role for row-proven owner work.
GRANT stella_system TO CURRENT_USER WITH SET TRUE, INHERIT FALSE;
--> statement-breakpoint
-- Organization system policies are installed one table per online transaction.
--> statement-breakpoint
GRANT SELECT ON TABLE public."user" TO stella_system;
--> statement-breakpoint
-- The user read policy has its own registered online step.
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
