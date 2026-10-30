-- requires: 20261030200619_member_removal_role
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint
CREATE ROLE stella_correspondence_offboarding NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;--> statement-breakpoint
-- stella-migration-safety: reviewed grant-privileges - Only the migration owner can select this role for typed member removal work.
GRANT stella_correspondence_offboarding TO CURRENT_USER WITH SET TRUE, INHERIT FALSE;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO stella_correspondence_offboarding;--> statement-breakpoint
GRANT SELECT (id, organization_id, assignee_id), UPDATE (assignee_id, updated_at) ON TABLE public.correspondence TO stella_correspondence_offboarding;
