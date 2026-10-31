-- requires: 20261031203138_folio_collab_token_offboarding_role
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
CREATE ROLE stella_member_exchange_offboarding NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;--> statement-breakpoint
-- stella-migration-safety: reviewed grant-privileges - The private member owner selects this intent only after locking the target membership and its workspace rows.
GRANT stella_member_exchange_offboarding TO CURRENT_USER WITH SET TRUE, INHERIT FALSE;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO stella_member_exchange_offboarding;--> statement-breakpoint
GRANT SELECT (id, organization_id, user_id) ON TABLE public.member TO stella_member_exchange_offboarding;--> statement-breakpoint
GRANT SELECT (id, organization_id) ON TABLE public.workspaces TO stella_member_exchange_offboarding;--> statement-breakpoint
GRANT SELECT (id, workspace_id, created_by), DELETE ON TABLE public.desktop_edit_handoffs TO stella_member_exchange_offboarding;--> statement-breakpoint
GRANT SELECT (id, workspace_id, created_by), DELETE ON TABLE public.pdf_signing_sessions TO stella_member_exchange_offboarding;
