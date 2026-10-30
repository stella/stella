-- requires: 20261030053602_registered_review_reset
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint
CREATE ROLE stella_member_removal NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;--> statement-breakpoint
-- stella-migration-safety: reviewed grant-privileges - The migration owner selects this role only within the typed member removal transaction.
GRANT stella_member_removal TO CURRENT_USER WITH SET TRUE, INHERIT FALSE;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO stella_member_removal;--> statement-breakpoint
GRANT DELETE ON TABLE public.member TO stella_member_removal;
