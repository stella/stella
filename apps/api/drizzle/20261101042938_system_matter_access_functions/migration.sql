SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Scoped background recovery asks the same matter-access rule as requests.
-- The wrapper runs as its caller, so it also needs the read function's grant.
GRANT EXECUTE ON FUNCTION public.stella_authorized_workspace_ids(text, text) TO stella_system;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stella_workspace_access(text, text, uuid) TO stella_system;
