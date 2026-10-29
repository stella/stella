SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE public.case_law_replay_reported_decisions ADD COLUMN tier text NOT NULL DEFAULT 'reported';--> statement-breakpoint
ALTER TABLE public.case_law_replay_reported_decisions ADD CONSTRAINT case_law_replay_hint_tier_check CHECK (tier IN ('reported', 'visited')) NOT VALID;--> statement-breakpoint
CREATE TABLE public.case_law_replay_visited_quotas (
  source_id uuid NOT NULL,
  window_started_at timestamptz NOT NULL,
  admitted_rows integer NOT NULL DEFAULT 0,
  CONSTRAINT case_law_replay_visited_quotas_pkey PRIMARY KEY(source_id),
  CONSTRAINT case_law_replay_visited_quota_source_fk FOREIGN KEY(source_id) REFERENCES public.case_law_sources(id) ON DELETE RESTRICT,
  CONSTRAINT case_law_replay_visited_quota_rows_check CHECK(admitted_rows >= 0 AND admitted_rows <= 60)
);--> statement-breakpoint
CREATE INDEX case_law_replay_visited_quota_expiry_idx ON public.case_law_replay_visited_quotas (window_started_at, source_id);--> statement-breakpoint
ALTER TABLE public.case_law_replay_visited_quotas ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.case_law_replay_visited_quotas FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY case_law_replay_visited_quota_owner_access ON public.case_law_replay_visited_quotas FOR ALL TO public
USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_replay_visited_quotas'::regclass))
WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_replay_visited_quotas'::regclass));--> statement-breakpoint
REVOKE ALL ON public.case_law_replay_visited_quotas FROM PUBLIC, stella;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - extend replay action vocabulary in the same transaction while retaining every existing action
ALTER TABLE public.case_law_replay_audit_events DROP CONSTRAINT case_law_replay_audit_events_action_check;--> statement-breakpoint
ALTER TABLE public.case_law_replay_audit_events ADD CONSTRAINT case_law_replay_audit_events_action_check CHECK (action IN ('source-scheduled', 'reported-decision-queued', 'visited-decisions-queued', 'daily-row-charged', 'receipt-superseded', 'checkpoint-created', 'gate-state-saved', 'receipt-reserved', 'progress-completed', 'receipt-applied', 'receipt-failed', 'receipt-blocked', 'dry-run-advanced', 'dry-run-reset', 'receipts-compacted', 'tick-recorded')) NOT VALID;
