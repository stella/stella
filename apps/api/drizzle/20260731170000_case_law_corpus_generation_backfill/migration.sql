SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- stella-migration-safety: reviewed destructive-change - widening varchar(32) -> varchar(64) is a metadata-only catalog change with no table rewrite or data loss; it aligns every physical corpus-index identifier column with the maximum constructed identifier length.
ALTER TABLE "case_law_decisions" ALTER COLUMN "indexed_generation" SET DATA TYPE varchar(64);--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - widening varchar(32) -> varchar(64) is a metadata-only catalog change with no table rewrite or data loss; it aligns every physical corpus-index identifier column with the maximum constructed identifier length.
ALTER TABLE "case_law_index_jobs" ALTER COLUMN "generation" SET DATA TYPE varchar(64);--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - widening varchar(32) -> varchar(64) is a metadata-only catalog change with no table rewrite or data loss; it aligns every physical corpus-index identifier column with the maximum constructed identifier length.
ALTER TABLE "legislation_documents" ALTER COLUMN "indexed_generation" SET DATA TYPE varchar(64);--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - widening varchar(32) -> varchar(64) is a metadata-only catalog change with no table rewrite or data loss; it aligns every physical corpus-index identifier column with the maximum constructed identifier length.
ALTER TABLE "legislation_index_jobs" ALTER COLUMN "generation" SET DATA TYPE varchar(64);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "case_law_corpus_index_backfills" (
  "generation" varchar(32) PRIMARY KEY NOT NULL,
  "snapshot_at" timestamptz NOT NULL DEFAULT now(),
  "cursor_created_at" timestamptz,
  "cursor_id" uuid,
  "status" text NOT NULL DEFAULT 'running',
  "lease_token" uuid,
  "lease_expires_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "case_law_corpus_index_backfills_status_values" CHECK ("status" IN ('running','complete')),
  CONSTRAINT "case_law_corpus_index_backfills_cursor_pair" CHECK (("cursor_created_at" IS NULL) = ("cursor_id" IS NULL)),
  CONSTRAINT "case_law_corpus_index_backfills_lease_pair" CHECK (("lease_token" IS NULL) = ("lease_expires_at" IS NULL))
);--> statement-breakpoint
ALTER TABLE "case_law_corpus_index_backfills" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $policy$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'case_law_corpus_index_backfills'
      AND policyname = 'case_law_global_access'
  ) THEN
    CREATE POLICY "case_law_global_access"
      ON "case_law_corpus_index_backfills"
      AS PERMISSIVE FOR SELECT TO stella
      USING (true);
  END IF;
END
$policy$;--> statement-breakpoint
DO $policy$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'case_law_corpus_index_backfills'
      AND policyname = 'case_law_ingestion_access'
  ) THEN
    CREATE POLICY "case_law_ingestion_access"
      ON "case_law_corpus_index_backfills"
      AS PERMISSIVE FOR ALL TO stella_ingestion
      USING (true) WITH CHECK (true);
  END IF;
END
$policy$;--> statement-breakpoint
GRANT SELECT ON TABLE "case_law_corpus_index_backfills" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "case_law_corpus_index_backfills" TO stella_ingestion;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "case_law_corpus_index_source_reconciliations" (
  "generation" varchar(32) NOT NULL,
  "source_id" uuid NOT NULL,
  "revision" integer NOT NULL DEFAULT 1,
  "cursor_created_at" timestamptz,
  "cursor_id" uuid,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "case_law_corpus_index_source_reconciliations_pk"
    PRIMARY KEY ("generation", "source_id"),
  CONSTRAINT "case_law_corpus_index_source_reconciliations_generation_fk"
    FOREIGN KEY ("generation") REFERENCES "case_law_corpus_index_backfills"("generation") ON DELETE CASCADE,
  CONSTRAINT "case_law_corpus_index_source_reconciliations_source_fk"
    FOREIGN KEY ("source_id") REFERENCES "case_law_sources"("id") ON DELETE CASCADE,
  CONSTRAINT "case_law_corpus_index_source_reconciliations_cursor_pair"
    CHECK (("cursor_created_at" IS NULL) = ("cursor_id" IS NULL))
);--> statement-breakpoint
ALTER TABLE "case_law_corpus_index_source_reconciliations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $policy$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'case_law_corpus_index_source_reconciliations'
      AND policyname = 'case_law_global_access'
  ) THEN
    CREATE POLICY "case_law_global_access"
      ON "case_law_corpus_index_source_reconciliations"
      AS PERMISSIVE FOR SELECT TO stella
      USING (true);
  END IF;
END
$policy$;--> statement-breakpoint
DO $policy$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'case_law_corpus_index_source_reconciliations'
      AND policyname = 'case_law_ingestion_access'
  ) THEN
    CREATE POLICY "case_law_ingestion_access"
      ON "case_law_corpus_index_source_reconciliations"
      AS PERMISSIVE FOR ALL TO stella_ingestion
      USING (true) WITH CHECK (true);
  END IF;
END
$policy$;--> statement-breakpoint
GRANT SELECT ON TABLE "case_law_corpus_index_source_reconciliations" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "case_law_corpus_index_source_reconciliations" TO stella_ingestion;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "case_law_corpus_index_writer_leases" (
  "generation" varchar(32) PRIMARY KEY NOT NULL,
  "lease_token" uuid,
  "lease_expires_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "case_law_corpus_index_writer_leases_pair"
    CHECK (("lease_token" IS NULL) = ("lease_expires_at" IS NULL))
);--> statement-breakpoint
ALTER TABLE "case_law_corpus_index_writer_leases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $policy$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'case_law_corpus_index_writer_leases'
      AND policyname = 'case_law_global_access'
  ) THEN
    CREATE POLICY "case_law_global_access"
      ON "case_law_corpus_index_writer_leases"
      AS PERMISSIVE FOR SELECT TO stella
      USING (true);
  END IF;
END
$policy$;--> statement-breakpoint
DO $policy$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'case_law_corpus_index_writer_leases'
      AND policyname = 'case_law_ingestion_access'
  ) THEN
    CREATE POLICY "case_law_ingestion_access"
      ON "case_law_corpus_index_writer_leases"
      AS PERMISSIVE FOR ALL TO stella_ingestion
      USING (true) WITH CHECK (true);
  END IF;
END
$policy$;--> statement-breakpoint
GRANT SELECT ON TABLE "case_law_corpus_index_writer_leases" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "case_law_corpus_index_writer_leases" TO stella_ingestion;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "case_law_corpus_index_projections" (
  "generation" varchar(32) NOT NULL,
  "decision_id" uuid NOT NULL,
  "index_id" varchar(64),
  "indexed_hash" varchar(64),
  "pending_action" text,
  "pending_hash" varchar(64),
  "pending_index_ids" varchar(64)[] DEFAULT '{}'::varchar(64)[] NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "case_law_corpus_index_projections_pk" PRIMARY KEY ("generation", "decision_id"),
  CONSTRAINT "case_law_corpus_index_projections_generation_fk"
    FOREIGN KEY ("generation") REFERENCES "case_law_corpus_index_backfills"("generation") ON DELETE CASCADE,
  CONSTRAINT "case_law_corpus_index_projections_decision_fk"
    FOREIGN KEY ("decision_id") REFERENCES "case_law_decisions"("id") ON DELETE CASCADE,
  CONSTRAINT "case_law_corpus_index_projections_index_pair"
    CHECK (("index_id" IS NULL) = ("indexed_hash" IS NULL)),
  CONSTRAINT "case_law_corpus_index_projections_pending_shape"
    CHECK (
      (
        ("pending_action" IS NULL AND "pending_hash" IS NULL AND cardinality("pending_index_ids") = 0)
        OR ("pending_action" = 'index' AND "pending_hash" IS NOT NULL AND cardinality("pending_index_ids") > 0)
        OR ("pending_action" = 'delete' AND "pending_hash" IS NULL)
      ) IS TRUE
    )
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "case_law_corpus_index_projections_pending_idx"
  ON "case_law_corpus_index_projections" ("generation", "decision_id")
  WHERE "pending_action" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "case_law_corpus_index_projections_decision_idx"
  ON "case_law_corpus_index_projections" ("decision_id");--> statement-breakpoint
ALTER TABLE "case_law_corpus_index_projections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $policy$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'case_law_corpus_index_projections'
      AND policyname = 'case_law_global_access'
  ) THEN
    CREATE POLICY "case_law_global_access"
      ON "case_law_corpus_index_projections"
      AS PERMISSIVE FOR SELECT TO stella
      USING (true);
  END IF;
END
$policy$;--> statement-breakpoint
DO $policy$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'case_law_corpus_index_projections'
      AND policyname = 'case_law_ingestion_access'
  ) THEN
    CREATE POLICY "case_law_ingestion_access"
      ON "case_law_corpus_index_projections"
      AS PERMISSIVE FOR ALL TO stella_ingestion
      USING (true) WITH CHECK (true);
  END IF;
END
$policy$;--> statement-breakpoint
GRANT SELECT ON TABLE "case_law_corpus_index_projections" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "case_law_corpus_index_projections" TO stella_ingestion;--> statement-breakpoint

CREATE OR REPLACE FUNCTION enqueue_case_law_corpus_index_projection()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.content_hash IS NULL THEN
    INSERT INTO case_law_corpus_index_projections (
      generation,
      decision_id,
      pending_action,
      pending_hash,
      pending_index_ids,
      updated_at
    )
    SELECT checkpoint.generation, NEW.id, 'delete', null, '{}', clock_timestamp()
    FROM case_law_corpus_index_backfills AS checkpoint
    WHERE EXISTS (
      SELECT 1
      FROM case_law_corpus_index_projections AS existing
      WHERE existing.generation = checkpoint.generation
        AND existing.decision_id = NEW.id
    ) OR NOT EXISTS (
        SELECT 1
        FROM case_law_corpus_index_backfills AS newer
        WHERE (newer.snapshot_at, newer.generation) >
          (checkpoint.snapshot_at, checkpoint.generation)
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
        updated_at = EXCLUDED.updated_at;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
    AND NEW.indexed_hash IS NOT NULL
    AND NEW.content_hash IS NOT DISTINCT FROM OLD.content_hash
    AND NEW.country IS NOT DISTINCT FROM OLD.country
  THEN
    -- The ordinary incremental writer owns the serving generation while a
    -- newer generation may be rebuilding. Its successful database mark is
    -- also the authoritative projection commit for that serving generation;
    -- the newer generation's independently queued action remains untouched.
    UPDATE case_law_corpus_index_projections AS projection
    SET index_id = NEW.indexed_generation,
        indexed_hash = NEW.indexed_hash,
        pending_action = null,
        pending_hash = null,
        pending_index_ids = '{}',
        updated_at = clock_timestamp()
    WHERE projection.decision_id = NEW.id
      AND NEW.indexed_generation =
        (projection.generation || '_' || lower(NEW.country));
    RETURN NEW;
  END IF;

  INSERT INTO case_law_corpus_index_projections (
    generation,
    decision_id,
    pending_action,
    pending_hash,
    pending_index_ids,
    updated_at
  )
  SELECT checkpoint.generation,
         NEW.id,
         'index',
         NEW.content_hash,
         ARRAY[checkpoint.generation || '_' || lower(NEW.country)],
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
      WHERE (newer.snapshot_at, newer.generation) >
        (checkpoint.snapshot_at, checkpoint.generation)
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
      updated_at = EXCLUDED.updated_at;

  RETURN NEW;
END
$function$;--> statement-breakpoint

-- stella-migration-safety: reviewed destructive-change - retry cleanup replaces only this migration's projection trigger; table data is unchanged.
DROP TRIGGER IF EXISTS case_law_decisions_enqueue_corpus_index_projection
  ON "case_law_decisions";--> statement-breakpoint
CREATE TRIGGER case_law_decisions_enqueue_corpus_index_projection
AFTER INSERT OR UPDATE OF content_hash, indexed_hash, country
ON "case_law_decisions"
FOR EACH ROW
EXECUTE FUNCTION enqueue_case_law_corpus_index_projection();--> statement-breakpoint

CREATE OR REPLACE FUNCTION enqueue_case_law_corpus_source_reconciliation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF coalesce(NEW.descriptor ->> 'allowsRedistribution', 'true')
    IS NOT DISTINCT FROM
    coalesce(OLD.descriptor ->> 'allowsRedistribution', 'true')
  THEN
    RETURN NEW;
  END IF;

  INSERT INTO case_law_corpus_index_source_reconciliations (
    generation,
    source_id,
    revision,
    cursor_created_at,
    cursor_id,
    updated_at
  )
  SELECT checkpoint.generation, NEW.id, 1, null, null, clock_timestamp()
  FROM case_law_corpus_index_backfills AS checkpoint
  WHERE EXISTS (
    SELECT 1
    FROM case_law_corpus_index_projections AS existing
    INNER JOIN case_law_decisions AS existing_decision
      ON existing_decision.id = existing.decision_id
    WHERE existing.generation = checkpoint.generation
      AND existing_decision.source_id = NEW.id
  ) OR NOT EXISTS (
      SELECT 1
      FROM case_law_corpus_index_backfills AS newer
      WHERE (newer.snapshot_at, newer.generation) >
        (checkpoint.snapshot_at, checkpoint.generation)
    )
  ON CONFLICT ON CONSTRAINT case_law_corpus_index_source_reconciliations_pk DO UPDATE
  SET revision = case_law_corpus_index_source_reconciliations.revision + 1,
      cursor_created_at = null,
      cursor_id = null,
      updated_at = EXCLUDED.updated_at;

  RETURN NEW;
END
$function$;--> statement-breakpoint

-- stella-migration-safety: reviewed destructive-change - retry cleanup replaces only this migration's source reconciliation trigger; table data is unchanged.
DROP TRIGGER IF EXISTS case_law_sources_enqueue_corpus_reconciliation
  ON "case_law_sources";--> statement-breakpoint
CREATE TRIGGER case_law_sources_enqueue_corpus_reconciliation
AFTER UPDATE OF descriptor
ON "case_law_sources"
FOR EACH ROW
EXECUTE FUNCTION enqueue_case_law_corpus_source_reconciliation();--> statement-breakpoint

-- Statement time, rather than transaction-start time, makes the rebuild's
-- short table-lock barrier a valid created_at high-water mark.
ALTER TABLE "case_law_decisions"
  ALTER COLUMN "created_at" SET DEFAULT clock_timestamp();--> statement-breakpoint

-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
-- A cancelled concurrent build leaves an INVALID index which IF NOT EXISTS
-- would silently accept on replay. Drop only this migration's index first.
-- stella-migration-safety: reviewed destructive-change - retry cleanup only; no table or column data is removed.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_corpus_generation_cursor_idx";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_decisions_corpus_generation_cursor_idx"
  ON "case_law_decisions" ("created_at", "id");--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - retry cleanup removes only this migration's derived-state index.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_source_generation_cursor_idx";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_decisions_source_generation_cursor_idx"
  ON "case_law_decisions" ("source_id", "created_at", "id");--> statement-breakpoint
-- Refreshes clear indexed_hash while retaining indexed_generation so the
-- indexer can remove a prior jurisdiction copy. Build that durable pending
-- signal under a new name: rolling-deployment tasks still use the legacy
-- indexed_generation predicate until they drain.
-- stella-migration-safety: reviewed destructive-change - retry cleanup removes only this migration's derived-state index.
DROP INDEX CONCURRENTLY IF EXISTS "case_law_decisions_corpus_hash_pending_idx";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "case_law_decisions_corpus_hash_pending_idx"
  ON "case_law_decisions" ("id")
  WHERE "content_hash" IS NOT NULL AND "indexed_hash" IS NULL;--> statement-breakpoint
-- stella-migration-safety: reviewed destructive-change - retry cleanup removes only this migration's derived-state index.
DROP INDEX CONCURRENTLY IF EXISTS "legislation_documents_corpus_hash_pending_idx";--> statement-breakpoint
-- squawk-ignore prefer-robust-stmts
CREATE INDEX CONCURRENTLY "legislation_documents_corpus_hash_pending_idx"
  ON "legislation_documents" ("id")
  WHERE "content_hash" IS NOT NULL AND "indexed_hash" IS NULL;--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;--> statement-breakpoint
