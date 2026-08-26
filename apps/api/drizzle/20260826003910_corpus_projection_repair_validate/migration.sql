SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "corpus_index_projection_states"
  VALIDATE CONSTRAINT "corpus_index_projection_states_work_status_values";--> statement-breakpoint

ALTER TABLE "corpus_index_projection_states"
  VALIDATE CONSTRAINT "corpus_index_projection_states_work_shape";--> statement-breakpoint
