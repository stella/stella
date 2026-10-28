-- requires: 20261022120100_professional_use_acceptance_owner_backfill
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

ALTER TABLE case_law_decision_identifier_backfills
  ADD COLUMN repaired_count integer NOT NULL DEFAULT 0,
  ADD COLUMN last_completed_repaired_count integer NOT NULL DEFAULT 0,
  ADD COLUMN last_completed_at timestamptz,
  ADD COLUMN verification_retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN verification_retry_after timestamptz;--> statement-breakpoint

ALTER TABLE case_law_decision_identifier_backfills
  ADD CONSTRAINT case_law_identifier_retry_shape
  CHECK (verification_retry_count BETWEEN 0 AND 3
    AND (verification_retry_count = 3) = (verification_retry_after IS NOT NULL)) NOT VALID;
