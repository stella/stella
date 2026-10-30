-- requires: 20261030195919_org_scoped_system_work
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

GRANT SELECT (id, task, schedule, payload, locked_by) ON public.scheduler_jobs TO stella_system;--> statement-breakpoint
GRANT INSERT (id, task, description, schedule, payload, enabled, next_run_at, updated_at) ON public.scheduler_jobs TO stella_system;--> statement-breakpoint
GRANT UPDATE (task, description, schedule, payload, enabled, next_run_at, updated_at) ON public.scheduler_jobs TO stella_system;--> statement-breakpoint
GRANT DELETE ON public.scheduler_jobs TO stella_system;

-- The online policy owner installs the live-source row predicates through its table gate.
