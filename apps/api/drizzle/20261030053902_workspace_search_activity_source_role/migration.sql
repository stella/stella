-- requires: 20261030053802_correspondence_offboarding_role
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
CREATE ROLE stella_workspace_search_activity NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;--> statement-breakpoint
-- stella-migration-safety: reviewed grant-privileges - Only the migration owner can enter the typed activity projection role.
GRANT stella_workspace_search_activity TO CURRENT_USER WITH SET TRUE, INHERIT FALSE;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO stella_workspace_search_activity;--> statement-breakpoint
GRANT SELECT (id, organization_id, last_activity_at) ON TABLE public.workspaces TO stella_workspace_search_activity;
