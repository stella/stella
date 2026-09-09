SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The per-row projection queue, its rebuild checkpoints, its writer leases and
-- its exact-count accounting served one corpus index path. Nothing reads or
-- writes any of it: the serving path keeps desired and applied state in
-- corpus_index_projection_states, driven by corpus_index_projection_intents.

-- stella-migration-safety: reviewed drop-object - the trigger's only purpose
-- was to enqueue rows into case_law_corpus_index_projections, dropped below.
DROP TRIGGER IF EXISTS case_law_decisions_enqueue_corpus_index_projection
  ON "case_law_decisions";--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - the trigger only wrote
-- case_law_corpus_index_source_reconciliations, dropped below.
DROP TRIGGER IF EXISTS case_law_sources_enqueue_corpus_reconciliation
  ON "case_law_sources";--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - the body of the trigger dropped above; rollback restores it with that
-- trigger from the migration that created it.
DROP FUNCTION IF EXISTS enqueue_case_law_corpus_index_projection();--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - the body of the trigger dropped above; rollback restores it with that
-- trigger from the migration that created it.
DROP FUNCTION IF EXISTS enqueue_case_law_corpus_source_reconciliation();--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - a trigger body on case_law_corpus_index_backfills, dropped below with
-- that table; rollback restores both together.
DROP FUNCTION IF EXISTS seed_case_law_corpus_index_count_backfill();--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - a trigger body on case_law_corpus_index_projections, dropped below with
-- that table; rollback restores both together.
DROP FUNCTION IF EXISTS derive_case_law_corpus_index_accounting();--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - a trigger body on case_law_corpus_index_projections, dropped below with
-- that table; rollback restores both together.
DROP FUNCTION IF EXISTS add_inserted_case_law_corpus_index_counts();--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - a trigger body on case_law_corpus_index_projections, dropped below with
-- that table; rollback restores both together.
DROP FUNCTION IF EXISTS apply_updated_case_law_corpus_index_counts();--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - a trigger body on case_law_corpus_index_projections, dropped below with
-- that table; rollback restores both together.
DROP FUNCTION IF EXISTS subtract_deleted_case_law_corpus_index_counts();--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - no caller remains: the query layer renders the same expression inline,
-- and the trigger that called it is dropped above.
DROP FUNCTION IF EXISTS case_law_corpus_index_id(text, text);--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - the composite type carried
-- the count triggers' per-bucket deltas and has no other user.
DROP TYPE IF EXISTS case_law_corpus_index_count_delta;--> statement-breakpoint

-- The reader roles hold their grants by name, and a dropped object takes its
-- grants with it silently. Revoking first keeps the granted set derivable from
-- the migration history alone.
REVOKE SELECT ON TABLE "case_law_corpus_index_projections"
  FROM "stella_public_law_reader";--> statement-breakpoint

REVOKE SELECT ON TABLE "case_law_corpus_index_projections"
  FROM "stella_caselaw_reader";--> statement-breakpoint

REVOKE SELECT ("indexed_hash") ON TABLE "case_law_decisions"
  FROM "stella_public_law_reader";--> statement-breakpoint

REVOKE SELECT ("indexed_hash") ON TABLE "legislation_documents"
  FROM "stella_public_law_reader";--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - one statement so the
-- foreign keys between these relations cannot order the drops wrongly. Every
-- row is derived projection bookkeeping for the retired path; the canonical
-- corpus rows they pointed at are untouched.
DROP TABLE IF EXISTS
  "case_law_corpus_index_count_backfills",
  "case_law_corpus_index_counts",
  "case_law_corpus_index_projections",
  "case_law_corpus_index_source_reconciliations",
  "case_law_corpus_index_writer_leases",
  "case_law_corpus_index_backfills",
  "case_law_corpus_index_delete_watermarks",
  "case_law_corpus_index_pending_deletes",
  "legislation_corpus_index_delete_watermarks",
  "legislation_corpus_index_pending_deletes";--> statement-breakpoint

-- stella-migration-safety: reviewed drop-column - the markers answered "which
-- physical index holds this row's content". The serving path answers that from
-- corpus_index_projection_states instead, and the indexes over these columns
-- are dropped with them.
ALTER TABLE "case_law_decisions"
  DROP COLUMN IF EXISTS "indexed_hash",
  DROP COLUMN IF EXISTS "indexed_generation",
  DROP COLUMN IF EXISTS "indexed_at";--> statement-breakpoint

-- stella-migration-safety: reviewed drop-column - the legislation twins of the
-- markers above, with the same replacement.
ALTER TABLE "legislation_documents"
  DROP COLUMN IF EXISTS "indexed_hash",
  DROP COLUMN IF EXISTS "indexed_generation",
  DROP COLUMN IF EXISTS "indexed_at";--> statement-breakpoint

-- stella-migration-safety: reviewed delete-data - registrations for the
-- retired cluster. The reader resolves a registration's cluster through the
-- generation contract, which no longer knows them, so leaving them would make
-- the read fail rather than skip. The predicate is the registration's own
-- cluster column, not a list of names.
DELETE FROM "corpus_index_generations" WHERE "cluster" <> 'q09';--> statement-breakpoint

-- stella-migration-safety: reviewed drop-constraint - the check is recreated
-- immediately below over the remaining cluster identifier, after the rows it
-- would have rejected are gone.
ALTER TABLE "corpus_index_generations"
  DROP CONSTRAINT IF EXISTS "corpus_index_generations_cluster_values";--> statement-breakpoint

ALTER TABLE "corpus_index_generations"
  ADD CONSTRAINT "corpus_index_generations_cluster_values"
    CHECK ("cluster" IN ('q09'));--> statement-breakpoint

-- An erasure or a withdrawal targets whichever generations hold the document,
-- so its audit row names none. Widening only: a row that already carries a
-- generation keeps it.
ALTER TABLE "case_law_index_jobs"
  ALTER COLUMN "generation" DROP NOT NULL;
