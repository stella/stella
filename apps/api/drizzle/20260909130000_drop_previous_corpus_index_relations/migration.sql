SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The relations only the retired corpus index path owned. Separate from the
-- migration that dropped its triggers and columns: unlinking these segments
-- happens at commit, and a file is one transaction, so dropping them here
-- keeps that work off the lock the canonical tables were taken under.

-- The reader roles hold their grants by name, and a dropped relation takes its
-- grants with it silently. Revoking first keeps the granted set derivable from
-- the migration history alone.
REVOKE SELECT (
  "generation", "decision_id", "index_id", "indexed_hash", "pending_action"
) ON TABLE "case_law_corpus_index_projections"
  FROM "stella_public_law_reader";--> statement-breakpoint

REVOKE SELECT ON TABLE "case_law_corpus_index_projections"
  FROM "stella_caselaw_reader";--> statement-breakpoint

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

-- stella-migration-safety: reviewed drop-object - the composite type carried
-- the count triggers' per-bucket deltas and has no other user; those triggers
-- and their functions are already gone.
DROP TYPE IF EXISTS case_law_corpus_index_count_delta;--> statement-breakpoint

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

-- Added NOT VALID so this transaction does not scan the table behind an
-- ACCESS EXCLUSIVE lock. The rows it would have rejected are deleted above,
-- and the next migration validates it in its own transaction.
ALTER TABLE "corpus_index_generations"
  ADD CONSTRAINT "corpus_index_generations_cluster_values"
    CHECK ("cluster" IN ('q09')) NOT VALID;
