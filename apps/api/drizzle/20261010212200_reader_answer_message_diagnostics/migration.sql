-- requires: 20261010212100_reader_answers
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "legal_reader_answer_messages"
  ADD COLUMN IF NOT EXISTS "error_code" text,
  ADD COLUMN IF NOT EXISTS "invalid_citation_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - Recreates the same diagnostic checks in this transaction so retries preserve their allowed values.
ALTER TABLE "legal_reader_answer_messages"
  DROP CONSTRAINT IF EXISTS "legal_reader_answer_messages_error_code_values",
  DROP CONSTRAINT IF EXISTS "legal_reader_answer_messages_invalid_citation_count_nonnegative";--> statement-breakpoint

ALTER TABLE "legal_reader_answer_messages"
  ADD CONSTRAINT "legal_reader_answer_messages_error_code_values"
  CHECK ("error_code" IS NULL OR "error_code" IN (
    'action_period_exhausted', 'action_concurrency_busy', 'action_not_enabled',
    'action_admission_unavailable', 'boundary-refusal', 'connector-discovery',
    'empty-response', 'internal', 'persistence', 'provider-error',
    'unsupported-input', 'client-disconnected', 'owner-lost', 'timeout'
  )) NOT VALID,
  ADD CONSTRAINT "legal_reader_answer_messages_invalid_citation_count_nonnegative"
  CHECK ("invalid_citation_count" >= 0) NOT VALID;--> statement-breakpoint

-- Release the schema lock before validation scans existing messages.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;--> statement-breakpoint

-- squawk-ignore constraint-missing-not-valid -- Added NOT VALID in the committed transaction above; validation holds no earlier schema lock.
ALTER TABLE "legal_reader_answer_messages"
  VALIDATE CONSTRAINT "legal_reader_answer_messages_error_code_values";--> statement-breakpoint
-- squawk-ignore constraint-missing-not-valid -- Added NOT VALID in the committed transaction above; validation holds no earlier schema lock.
ALTER TABLE "legal_reader_answer_messages"
  VALIDATE CONSTRAINT "legal_reader_answer_messages_invalid_citation_count_nonnegative";
