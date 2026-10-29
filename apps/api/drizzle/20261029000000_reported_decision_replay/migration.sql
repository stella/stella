SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE public.case_law_replay_source_progress ADD COLUMN last_full_replay_parser_version integer;--> statement-breakpoint
ALTER TABLE public.case_law_replay_source_progress ADD COLUMN last_full_replay_at timestamptz;--> statement-breakpoint
CREATE TABLE public.case_law_replay_reported_decisions (
  source_id uuid NOT NULL,
  decision_id uuid NOT NULL,
  target_parser_version integer NOT NULL,
  queued_at timestamptz NOT NULL DEFAULT now(),
  previewed_at timestamptz,
  completed_at timestamptz,
  CONSTRAINT case_law_replay_reported_decisions_pkey PRIMARY KEY(source_id, decision_id, target_parser_version),
  CONSTRAINT case_law_replay_reported_source_fk FOREIGN KEY (source_id) REFERENCES public.case_law_sources(id) ON DELETE RESTRICT,
  CONSTRAINT case_law_replay_reported_version_check CHECK (target_parser_version > 0)
);--> statement-breakpoint
CREATE INDEX case_law_replay_reported_pending_idx ON public.case_law_replay_reported_decisions(source_id, target_parser_version, queued_at, decision_id) WHERE completed_at IS NULL;--> statement-breakpoint
ALTER TABLE public.case_law_replay_reported_decisions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.case_law_replay_reported_decisions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.case_law_replay_reported_decisions FROM stella;--> statement-breakpoint
CREATE POLICY case_law_replay_reported_owner_access ON public.case_law_replay_reported_decisions FOR ALL TO public
USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_replay_reported_decisions'::regclass))
WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_replay_reported_decisions'::regclass));

--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - replace the action check in the same short transaction with its previous values plus reported-decision-queued
ALTER TABLE public.case_law_replay_audit_events DROP CONSTRAINT case_law_replay_audit_events_action_check;--> statement-breakpoint
ALTER TABLE public.case_law_replay_audit_events ADD CONSTRAINT case_law_replay_audit_events_action_check CHECK (action IN ('source-scheduled', 'reported-decision-queued', 'daily-row-charged', 'receipt-superseded', 'checkpoint-created', 'gate-state-saved', 'receipt-reserved', 'progress-completed', 'receipt-applied', 'receipt-failed', 'receipt-blocked', 'dry-run-advanced', 'dry-run-reset', 'receipts-compacted', 'tick-recorded')) NOT VALID;

--> statement-breakpoint
ALTER TABLE public.case_law_replay_source_progress ADD COLUMN dry_run_parser_version integer;--> statement-breakpoint
ALTER TABLE public.case_law_replay_source_progress ADD COLUMN dry_run_diff_samples jsonb NOT NULL DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE public.case_law_replay_source_progress ADD CONSTRAINT case_law_replay_diff_samples_check CHECK (jsonb_typeof(dry_run_diff_samples) = 'array' AND jsonb_array_length(dry_run_diff_samples) <= 20) NOT VALID;

--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - extend the blocked-reason check atomically so metadata-only replay never borrows the no-document withdrawal disposition
ALTER TABLE public.case_law_replay_blocked DROP CONSTRAINT case_law_replay_blocked_reason_check;--> statement-breakpoint
ALTER TABLE public.case_law_replay_blocked ADD CONSTRAINT case_law_replay_blocked_reason_check CHECK (reason IN ('missing-payload', 'incomplete-metadata', 'identity-mismatch', 'raw-fidelity-lost', 'unsupported-content', 'no-document', 'metadata-only', 'supplement')) NOT VALID;
