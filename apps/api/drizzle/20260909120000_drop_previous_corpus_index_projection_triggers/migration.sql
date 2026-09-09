SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The per-row projection queue and its exact-count accounting served one
-- corpus index path. Nothing reads or writes any of it: the serving path keeps
-- desired and applied state in corpus_index_projection_states, driven by
-- corpus_index_projection_intents.
--
-- This file takes the ACCESS EXCLUSIVE locks on the canonical tables: the
-- triggers, the functions behind them, and the columns. The relations that
-- only the retired path owns are dropped by the next migration, so unlinking
-- their segments at commit does not hold a lock on case_law_decisions.

-- stella-migration-safety: reviewed drop-object - the trigger's only purpose
-- was to enqueue rows into case_law_corpus_index_projections, dropped by the
-- next migration; rollback restores it with the function below.
DROP TRIGGER IF EXISTS case_law_decisions_enqueue_corpus_index_projection
  ON "case_law_decisions";--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - the trigger only wrote
-- case_law_corpus_index_source_reconciliations; rollback restores it with the
-- function below.
DROP TRIGGER IF EXISTS case_law_sources_enqueue_corpus_reconciliation
  ON "case_law_sources";--> statement-breakpoint

-- Each accounting trigger is dropped before the function it calls: a function
-- a trigger still references cannot be dropped without cascading.

-- stella-migration-safety: reviewed drop-object - seeded the count checkpoint
-- for a new generation; rollback restores it with its function.
DROP TRIGGER IF EXISTS case_law_corpus_index_backfill_seed_count
  ON "case_law_corpus_index_backfills";--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - derived the accounted index
-- of a projection row; rollback restores it with its function.
DROP TRIGGER IF EXISTS case_law_corpus_index_projection_derive_accounting
  ON "case_law_corpus_index_projections";--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - applied the per-index count
-- delta of inserted projection rows; rollback restores it with its function.
DROP TRIGGER IF EXISTS case_law_corpus_index_projection_count_insert
  ON "case_law_corpus_index_projections";--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - applied the per-index count
-- delta of updated projection rows; rollback restores it with its function.
DROP TRIGGER IF EXISTS case_law_corpus_index_projection_count_update
  ON "case_law_corpus_index_projections";--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - applied the per-index count
-- delta of deleted projection rows; rollback restores it with its function.
DROP TRIGGER IF EXISTS case_law_corpus_index_projection_count_delete
  ON "case_law_corpus_index_projections";--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - the body of a trigger
-- dropped above; rollback restores it with that trigger from the migration
-- that created it.
DROP FUNCTION IF EXISTS enqueue_case_law_corpus_index_projection();--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - the body of a trigger
-- dropped above; rollback restores it with that trigger from the migration
-- that created it.
DROP FUNCTION IF EXISTS enqueue_case_law_corpus_source_reconciliation();--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - the body of a trigger
-- dropped above; rollback restores both together.
DROP FUNCTION IF EXISTS seed_case_law_corpus_index_count_backfill();--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - the body of a trigger
-- dropped above; rollback restores both together.
DROP FUNCTION IF EXISTS derive_case_law_corpus_index_accounting();--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - the body of a trigger
-- dropped above; rollback restores both together.
DROP FUNCTION IF EXISTS add_inserted_case_law_corpus_index_counts();--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - the body of a trigger
-- dropped above; rollback restores both together.
DROP FUNCTION IF EXISTS apply_updated_case_law_corpus_index_counts();--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - the body of a trigger
-- dropped above; rollback restores both together.
DROP FUNCTION IF EXISTS subtract_deleted_case_law_corpus_index_counts();--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - no caller remains: the query
-- layer renders the same expression inline, and the trigger that called it is
-- dropped above.
DROP FUNCTION IF EXISTS case_law_corpus_index_id(text, text);--> statement-breakpoint

-- A dropped column takes its grants with it silently. Revoking first keeps the
-- granted set derivable from the migration history alone.
REVOKE SELECT ("indexed_hash") ON TABLE "case_law_decisions"
  FROM "stella_public_law_reader";--> statement-breakpoint

REVOKE SELECT ("indexed_hash") ON TABLE "legislation_documents"
  FROM "stella_public_law_reader";--> statement-breakpoint

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

-- An erasure or a withdrawal targets whichever generations hold the document,
-- so its audit row names none. Widening only: a row that already carries a
-- generation keeps it.
ALTER TABLE "case_law_index_jobs"
  ALTER COLUMN "generation" DROP NOT NULL;
