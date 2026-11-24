SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Admit the failure kind a projection state waits under when its canonical
-- row no longer derives it and re-deriving it did not move it. The
-- replacement lists every earlier kind, so no row the old check admitted is
-- refused.
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
        'canonical_input_mismatch',
        'append_unknown',
        'append_rejected',
        'append_transient'
      )
    ) NOT VALID;
