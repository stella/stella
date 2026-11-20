SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Admit the failure kind a revision is blocked under when its decision is
-- written in a language its jurisdiction does not declare. The replacement
-- lists every earlier kind, so no row the old check admitted is refused.
-- stella-migration-safety: reviewed drop-constraint - Drops only the failure-kind check immediately replaced below in the same transaction; no row data or unrelated constraints are changed.
ALTER TABLE "corpus_index_projection_states"
  DROP CONSTRAINT "corpus_index_projection_states_failure_kind_values";--> statement-breakpoint

ALTER TABLE "corpus_index_projection_states"
  ADD CONSTRAINT "corpus_index_projection_states_failure_kind_values"
    CHECK (
      "last_failure_kind" IS NULL
      OR "last_failure_kind" IN (
        'payload_unavailable',
        'revision_too_large',
        'document_language_undeclared',
        'append_unknown',
        'append_rejected',
        'append_transient'
      )
    ) NOT VALID;
