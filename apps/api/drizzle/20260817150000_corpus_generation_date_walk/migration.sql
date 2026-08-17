SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The corpus-index generation rebuild walked its snapshot in creation order.
-- A split's timestamp range spans everything written into it, so that order
-- gave every split the corpus' whole date range and left a date-filtered query
-- nothing to skip. The walk now goes in decision-date order, so a split holds a
-- contiguous span of dates.
--
-- The cursor changes with it: `(decision_date, id)` instead of
-- `(created_at, id)`, with undated decisions coalesced to `-infinity` so they
-- form the first band and one row comparison expresses the whole cursor.

ALTER TABLE "case_law_corpus_index_backfills"
  ADD COLUMN "cursor_walk_date" date;--> statement-breakpoint

-- The pair check follows the cursor to its new column. Dropping it first is
-- required, not cosmetic: it asserts the legacy column and the id are set
-- together, which the new writer, leaving the legacy column null, would
-- violate on its first advance.
-- stella-migration-safety: reviewed destructive-change - drops a check
-- constraint over the cursor columns and replaces it below with the same
-- invariant over the column the cursor now uses. No row data is touched.
ALTER TABLE "case_law_corpus_index_backfills"
  DROP CONSTRAINT IF EXISTS "case_law_corpus_index_backfills_cursor_pair";--> statement-breakpoint

-- A position in creation order is not a position in date order, so every
-- stored cursor is cleared rather than translated. A rebuild still running
-- restarts, which costs a re-scan and re-indexes nothing: a row already
-- rebuilt into the generation is current and is skipped. A finished rebuild
-- keeps its `complete` status, which is what routes it; its cursor only ever
-- served as the compare-and-set token its reconciliation lease claims against,
-- and the new writer compares against the cleared value.
-- stella-migration-safety: reviewed destructive-change - clears a derived
-- rebuild cursor whose ordering this release replaces; the rebuild it belongs
-- to reaches the same fixed point by re-walking.
-- stella-migration-safety: reviewed bulk-backfill - the table holds one row
-- per corpus-index generation, so the whole of it is a handful of rows.
UPDATE "case_law_corpus_index_backfills"
  SET "cursor_created_at" = NULL, "cursor_id" = NULL;--> statement-breakpoint

ALTER TABLE "case_law_corpus_index_backfills"
  ADD CONSTRAINT "case_law_corpus_index_backfills_cursor_pair"
  CHECK (("cursor_walk_date" IS NULL) = ("cursor_id" IS NULL)) NOT VALID;--> statement-breakpoint

-- `cursor_created_at` stays for now. A migration runs before the tasks of the
-- release that stops selecting it have finished rolling out, and dropping it
-- here would fail their checkpoint read, which the live pending drain shares.
-- Drop it in the next release.

-- A decision date is now part of two things it was not before: the document
-- the projection writes (its timestamp field) and the walk's position. A
-- correction to it therefore has to reach the pending queue. Without this, a
-- date moving behind the cursor takes its row out of the walk's remaining
-- range, and nothing else would notice.
CREATE OR REPLACE FUNCTION enqueue_case_law_corpus_index_projection()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.content_hash IS NULL THEN
      INSERT INTO case_law_corpus_index_projections (
        generation,
        decision_id,
        pending_action,
        pending_hash,
        pending_index_ids,
        pending_revision,
        updated_at
      )
      SELECT checkpoint.generation, NEW.id, 'delete', null, '{}', 1, clock_timestamp()
      FROM case_law_corpus_index_backfills AS checkpoint
      WHERE EXISTS (
        SELECT 1
        FROM case_law_corpus_index_projections AS existing
        WHERE existing.generation = checkpoint.generation
          AND existing.decision_id = NEW.id
      ) OR NOT EXISTS (
        SELECT 1
        FROM case_law_corpus_index_backfills AS newer
        WHERE (newer.generation_order, newer.generation) >
          (checkpoint.generation_order, checkpoint.generation)
      )
      ON CONFLICT ON CONSTRAINT case_law_corpus_index_projections_pk DO UPDATE
      SET pending_action = EXCLUDED.pending_action,
          pending_hash = EXCLUDED.pending_hash,
          pending_index_ids = ARRAY(
            SELECT DISTINCT target
            FROM unnest(
              case_law_corpus_index_projections.pending_index_ids || CASE
                WHEN case_law_corpus_index_projections.index_id IS NULL THEN '{}'
                ELSE ARRAY[case_law_corpus_index_projections.index_id]
              END
            ) AS target
          ),
          pending_revision = case_law_corpus_index_projections.pending_revision + 1,
          updated_at = EXCLUDED.updated_at;
      RETURN NEW;
    END IF;

    IF NEW.indexed_hash IS NOT NULL
      AND NEW.content_hash IS NOT DISTINCT FROM OLD.content_hash
      AND NEW.country IS NOT DISTINCT FROM OLD.country
      AND NEW.decision_date IS NOT DISTINCT FROM OLD.decision_date
    THEN
      -- The ordinary incremental writer owns the serving generation while a
      -- newer generation may be rebuilding. Its successful database mark is
      -- also the authoritative projection commit for that serving generation;
      -- the newer generation's independently queued action remains untouched.
      -- The decision date joins this guard because it reaches the document:
      -- an update that changes it is a content change for the index, however
      -- unchanged the text is.
      UPDATE case_law_corpus_index_projections AS projection
      SET index_id = NEW.indexed_generation,
          indexed_hash = NEW.indexed_hash,
          updated_at = clock_timestamp()
      WHERE projection.decision_id = NEW.id
        AND NEW.indexed_generation =
          (projection.generation || '_' || lower(NEW.country));
      RETURN NEW;
    END IF;
  END IF;

  IF NEW.content_hash IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO case_law_corpus_index_projections (
    generation,
    decision_id,
    pending_action,
    pending_hash,
    pending_index_ids,
    pending_revision,
    updated_at
  )
  SELECT checkpoint.generation,
         NEW.id,
         'index',
         NEW.content_hash,
         ARRAY[checkpoint.generation || '_' || lower(NEW.country)],
         1,
         clock_timestamp()
  FROM case_law_corpus_index_backfills AS checkpoint
  WHERE EXISTS (
    SELECT 1
    FROM case_law_corpus_index_projections AS existing
    WHERE existing.generation = checkpoint.generation
      AND existing.decision_id = NEW.id
  ) OR NOT EXISTS (
      SELECT 1
      FROM case_law_corpus_index_backfills AS newer
      WHERE (newer.generation_order, newer.generation) >
        (checkpoint.generation_order, checkpoint.generation)
    )
  ON CONFLICT ON CONSTRAINT case_law_corpus_index_projections_pk DO UPDATE
  SET pending_action = EXCLUDED.pending_action,
      pending_hash = EXCLUDED.pending_hash,
      pending_index_ids = ARRAY(
        SELECT DISTINCT target
        FROM unnest(
          case_law_corpus_index_projections.pending_index_ids || EXCLUDED.pending_index_ids
        ) AS target
      ),
      pending_revision = case_law_corpus_index_projections.pending_revision + 1,
      updated_at = EXCLUDED.updated_at;

  RETURN NEW;
END
$function$;--> statement-breakpoint

-- stella-migration-safety: reviewed destructive-change - replaces only this
-- trigger, to widen the column list it fires on; table data is unchanged.
DROP TRIGGER IF EXISTS case_law_decisions_enqueue_corpus_index_projection
  ON "case_law_decisions";--> statement-breakpoint
CREATE TRIGGER case_law_decisions_enqueue_corpus_index_projection
AFTER INSERT OR UPDATE OF content_hash, indexed_hash, country, decision_date
ON "case_law_decisions"
FOR EACH ROW
EXECUTE FUNCTION enqueue_case_law_corpus_index_projection();--> statement-breakpoint

-- Drizzle wraps pending migrations in one transaction, while PostgreSQL
-- requires CREATE INDEX CONCURRENTLY to run outside a transaction block. Split
-- the migrator transaction, lift the timeouts for the concurrent build, then
-- restore and reopen a transaction for Drizzle's migration row. Same shape as
-- 20260816210000_citation_authority_due_index.
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint

-- Validated outside the transaction that added it, so the scan cannot hold
-- reads for the rest of the migration. The rows it reads are the handful of
-- generation checkpoints, all of them cleared above.
ALTER TABLE "case_law_corpus_index_backfills"
  VALIDATE CONSTRAINT "case_law_corpus_index_backfills_cursor_pair";--> statement-breakpoint

-- The walk's page is an index range only if the index matches its ORDER BY
-- expression for expression, direction and tiebreaker. Apply this before the
-- next generation's rebuild starts; without it every page sorts the corpus.
-- stella-migration-safety: reviewed destructive-change - drops only this
-- migration's own index by name before recreating it. A cancelled concurrent
-- build leaves an INVALID index behind, and IF NOT EXISTS would then skip
-- recreating it.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_corpus_generation_date_cursor_idx";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_decisions_corpus_generation_date_cursor_idx" ON "case_law_decisions" ((coalesce("decision_date", '-infinity'::date)),"id");--> statement-breakpoint

-- The creation-ordered cursor index existed for this walk and has no other
-- reader: the source-eligibility pass keys on (source_id, created_at, id) and
-- the incremental scan on its own partial index.
-- stella-migration-safety: reviewed destructive-change - drops the index the
-- walk this migration re-orders was its only user.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_corpus_generation_cursor_idx";--> statement-breakpoint

SET statement_timeout = '5s';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
