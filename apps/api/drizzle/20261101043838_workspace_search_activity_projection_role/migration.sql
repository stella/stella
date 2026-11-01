-- requires: 20261101043738_workspace_search_activity_source_role
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
GRANT SELECT (workspace_id, organization_id, updated_at), UPDATE (updated_at) ON TABLE public.workspace_search_documents TO stella_workspace_search_activity;
