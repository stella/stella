-- requires: 20261010212200_reader_answer_message_diagnostics
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - Replaces the diagnostic check atomically with the same values plus the operator feature refusal.
ALTER TABLE "legal_reader_answer_messages"
  DROP CONSTRAINT IF EXISTS "legal_reader_answer_messages_error_code_values";--> statement-breakpoint

ALTER TABLE "legal_reader_answer_messages"
  ADD CONSTRAINT "legal_reader_answer_messages_error_code_values"
  CHECK ("error_code" IS NULL OR "error_code" IN (
    'action_period_exhausted', 'action_concurrency_busy', 'action_not_enabled',
    'action_admission_unavailable', 'action_feature_disabled', 'boundary-refusal',
    'connector-discovery', 'empty-response', 'internal', 'persistence', 'provider-error',
    'unsupported-input', 'client-disconnected', 'owner-lost', 'timeout'
  )) NOT VALID;--> statement-breakpoint

-- Release the schema lock before validating existing messages.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;--> statement-breakpoint

-- squawk-ignore constraint-missing-not-valid -- The replacement was added NOT VALID in the committed transaction above.
ALTER TABLE "legal_reader_answer_messages"
  VALIDATE CONSTRAINT "legal_reader_answer_messages_error_code_values";
