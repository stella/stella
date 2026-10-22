-- requires: 20261022120100_professional_use_acceptance_owner_backfill
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

ALTER TABLE case_law_decision_identifier_backfills
  ADD COLUMN repaired_by_court jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN last_completed_repaired_by_court jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN last_completed_at timestamptz;
