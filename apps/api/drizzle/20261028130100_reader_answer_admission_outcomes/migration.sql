-- requires: 20261024090100_reader_answer_feature_refusal
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - Replaces the diagnostic value check within the same transaction, preserving all message rows.
ALTER TABLE "legal_reader_answer_messages"
  DROP CONSTRAINT IF EXISTS "legal_reader_answer_messages_error_code_values";--> statement-breakpoint

ALTER TABLE "legal_reader_answer_messages"
  ADD CONSTRAINT "legal_reader_answer_messages_error_code_values"
  CHECK ("error_code" IS NULL OR "error_code" IN (
    'action_period_exhausted', 'action_concurrency_busy', 'action_not_enabled',
    'action_admission_unavailable', 'limiter_store_unavailable',
    'action_admission_configuration_incomplete',
    'action_admission_org_state_unreadable', 'action_admission_lease_lost',
    'action_feature_disabled', 'boundary-refusal', 'connector-discovery',
    'empty-response', 'internal', 'persistence', 'provider-error',
    'unsupported-input', 'client-disconnected', 'owner-lost', 'timeout'
  )) NOT VALID;
