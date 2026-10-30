-- requires: 20261030200919_workspace_search_activity_projection_role
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
CREATE ROLE stella_folio_collab_token_offboarding NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;--> statement-breakpoint
-- stella-migration-safety: reviewed grant-privileges - Only the typed member-removal owner selects this role, after it locks the target membership and every explicit matter.
GRANT stella_folio_collab_token_offboarding TO CURRENT_USER WITH SET TRUE, INHERIT FALSE;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO stella_folio_collab_token_offboarding;--> statement-breakpoint
GRANT SELECT (id, organization_id, user_id) ON TABLE public.member TO stella_folio_collab_token_offboarding;--> statement-breakpoint
GRANT SELECT (id, organization_id) ON TABLE public.workspaces TO stella_folio_collab_token_offboarding;--> statement-breakpoint
GRANT SELECT (id), DELETE ON TABLE public.folio_collab_room_tokens TO stella_folio_collab_token_offboarding;--> statement-breakpoint

-- The online policy owner installs each declared table policy in its own transaction.
