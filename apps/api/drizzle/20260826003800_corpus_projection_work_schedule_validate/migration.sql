SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Validate in a later migration transaction. The projection table remains
-- inert until Plane ships, so this completes the public constraint contract
-- before any durable work state can be written.
ALTER TABLE "corpus_index_projection_states"
  VALIDATE CONSTRAINT "corpus_index_projection_states_work_status_values";--> statement-breakpoint

ALTER TABLE "corpus_index_projection_states"
  VALIDATE CONSTRAINT "corpus_index_projection_states_failure_kind_values";--> statement-breakpoint

ALTER TABLE "corpus_index_projection_states"
  VALIDATE CONSTRAINT "corpus_index_projection_states_failure_attempts_nonnegative";--> statement-breakpoint

ALTER TABLE "corpus_index_projection_states"
  VALIDATE CONSTRAINT "corpus_index_projection_states_work_shape";--> statement-breakpoint

ALTER TABLE "corpus_index_projection_intents"
  VALIDATE CONSTRAINT "corpus_index_projection_intents_expected_document_count_shape";--> statement-breakpoint
