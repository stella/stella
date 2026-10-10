-- requires: 20261010005100_reader_answers
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "legal_reader_answer_messages"
  ADD COLUMN "error_code" text,
  ADD COLUMN "invalid_citation_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

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

ALTER TABLE "legal_reader_answer_messages"
  VALIDATE CONSTRAINT "legal_reader_answer_messages_error_code_values";--> statement-breakpoint
ALTER TABLE "legal_reader_answer_messages"
  VALIDATE CONSTRAINT "legal_reader_answer_messages_invalid_citation_count_nonnegative";
