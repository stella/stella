SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Nullable and metadata-only on the live projection table. Existing rows are
-- accounted by the bounded keyset backfill below; every new or changed row is
-- derived synchronously by the trigger installed in this migration.
ALTER TABLE "case_law_corpus_index_projections"
  ADD COLUMN "accounted_index_id" varchar(64);--> statement-breakpoint

ALTER TABLE "case_law_corpus_index_projections"
  ADD CONSTRAINT "case_law_corpus_index_projections_accounted_shape"
  CHECK (
    "accounted_index_id" IS NULL
    OR (
      "pending_action" IS NULL
      AND "indexed_hash" IS NOT NULL
      AND "accounted_index_id" = "index_id"
    )
  ) NOT VALID;--> statement-breakpoint

CREATE TABLE "case_law_corpus_index_counts" (
  "generation" varchar(32) NOT NULL,
  "index_id" varchar(64) NOT NULL,
  "marked_indexed" bigint DEFAULT 0 NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "case_law_corpus_index_counts_pk"
    PRIMARY KEY ("generation", "index_id"),
  CONSTRAINT "case_law_corpus_index_counts_generation_fk"
    FOREIGN KEY ("generation")
    REFERENCES "case_law_corpus_index_backfills"("generation")
    ON DELETE CASCADE,
  CONSTRAINT "case_law_corpus_index_counts_nonnegative"
    CHECK ("marked_indexed" >= 0)
);--> statement-breakpoint

ALTER TABLE "case_law_corpus_index_counts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access"
  ON "case_law_corpus_index_counts"
  AS PERMISSIVE FOR ALL TO stella_ingestion
  USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT ON TABLE "case_law_corpus_index_counts" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "case_law_corpus_index_counts" TO stella_ingestion;--> statement-breakpoint

CREATE TABLE "case_law_corpus_index_count_backfills" (
  "generation" varchar(32) PRIMARY KEY,
  "cursor_decision_id" uuid,
  "status" text DEFAULT 'running' NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "case_law_corpus_index_count_backfills_generation_fk"
    FOREIGN KEY ("generation")
    REFERENCES "case_law_corpus_index_backfills"("generation")
    ON DELETE CASCADE,
  CONSTRAINT "case_law_corpus_index_count_backfills_status_values"
    CHECK ("status" IN ('running', 'complete'))
);--> statement-breakpoint

ALTER TABLE "case_law_corpus_index_count_backfills" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access"
  ON "case_law_corpus_index_count_backfills"
  AS PERMISSIVE FOR ALL TO stella_ingestion
  USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT ON TABLE "case_law_corpus_index_count_backfills" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "case_law_corpus_index_count_backfills" TO stella_ingestion;--> statement-breakpoint

-- Only generations that predate this migration need a seed walk. A generation
-- created after the accounting trigger exists starts exact at zero.
INSERT INTO "case_law_corpus_index_count_backfills" ("generation", "status")
SELECT "generation", 'running'
FROM "case_law_corpus_index_backfills";--> statement-breakpoint

CREATE OR REPLACE FUNCTION derive_case_law_corpus_index_accounting()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  decision_content_hash varchar(64);
  decision_country varchar(3);
BEGIN
  SELECT decision.content_hash, decision.country
  INTO STRICT decision_content_hash, decision_country
  FROM case_law_decisions AS decision
  WHERE decision.id = NEW.decision_id;

  NEW.accounted_index_id := CASE
    WHEN NEW.pending_action IS NULL
      AND NEW.indexed_hash = decision_content_hash
      AND NEW.index_id = case_law_corpus_index_id(
        NEW.generation,
        decision_country
      )
    THEN NEW.index_id
    ELSE NULL
  END;
  RETURN NEW;
END
$function$;--> statement-breakpoint

CREATE TRIGGER case_law_corpus_index_projection_derive_accounting
BEFORE INSERT OR UPDATE OF generation, decision_id, index_id, indexed_hash, pending_action, accounted_index_id
ON "case_law_corpus_index_projections"
FOR EACH ROW
EXECUTE FUNCTION derive_case_law_corpus_index_accounting();--> statement-breakpoint

CREATE OR REPLACE FUNCTION add_inserted_case_law_corpus_index_counts()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO case_law_corpus_index_counts AS counts (
    generation,
    index_id,
    marked_indexed,
    updated_at
  )
  SELECT generation, accounted_index_id, count(*)::bigint, clock_timestamp()
  FROM new_projections
  WHERE accounted_index_id IS NOT NULL
  GROUP BY generation, accounted_index_id
  ON CONFLICT ON CONSTRAINT case_law_corpus_index_counts_pk DO UPDATE
  SET marked_indexed = counts.marked_indexed + EXCLUDED.marked_indexed,
      updated_at = EXCLUDED.updated_at;
  RETURN NULL;
END
$function$;--> statement-breakpoint

CREATE TRIGGER case_law_corpus_index_projection_count_insert
AFTER INSERT ON "case_law_corpus_index_projections"
REFERENCING NEW TABLE AS new_projections
FOR EACH STATEMENT
EXECUTE FUNCTION add_inserted_case_law_corpus_index_counts();--> statement-breakpoint

CREATE OR REPLACE FUNCTION apply_updated_case_law_corpus_index_counts()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  -- Materialize a zero bucket first. A negative delta without an existing
  -- bucket then violates the nonnegative CHECK instead of disappearing.
  WITH deltas AS (
    SELECT generation, index_id, sum(delta)::bigint AS delta
    FROM (
      SELECT generation, accounted_index_id AS index_id, -count(*)::bigint AS delta
      FROM old_projections
      WHERE accounted_index_id IS NOT NULL
      GROUP BY generation, accounted_index_id
      UNION ALL
      SELECT generation, accounted_index_id AS index_id, count(*)::bigint AS delta
      FROM new_projections
      WHERE accounted_index_id IS NOT NULL
      GROUP BY generation, accounted_index_id
    ) AS changes
    GROUP BY generation, index_id
    HAVING sum(delta) <> 0
  )
  INSERT INTO case_law_corpus_index_counts (
    generation,
    index_id,
    marked_indexed,
    updated_at
  )
  SELECT generation, index_id, 0, clock_timestamp()
  FROM deltas
  ON CONFLICT ON CONSTRAINT case_law_corpus_index_counts_pk DO NOTHING;

  WITH deltas AS (
    SELECT generation, index_id, sum(delta)::bigint AS delta
    FROM (
      SELECT generation, accounted_index_id AS index_id, -count(*)::bigint AS delta
      FROM old_projections
      WHERE accounted_index_id IS NOT NULL
      GROUP BY generation, accounted_index_id
      UNION ALL
      SELECT generation, accounted_index_id AS index_id, count(*)::bigint AS delta
      FROM new_projections
      WHERE accounted_index_id IS NOT NULL
      GROUP BY generation, accounted_index_id
    ) AS changes
    GROUP BY generation, index_id
    HAVING sum(delta) <> 0
  )
  UPDATE case_law_corpus_index_counts AS counts
  SET marked_indexed = counts.marked_indexed + deltas.delta,
      updated_at = clock_timestamp()
  FROM deltas
  WHERE counts.generation = deltas.generation
    AND counts.index_id = deltas.index_id;
  RETURN NULL;
END
$function$;--> statement-breakpoint

CREATE TRIGGER case_law_corpus_index_projection_count_update
AFTER UPDATE ON "case_law_corpus_index_projections"
REFERENCING OLD TABLE AS old_projections NEW TABLE AS new_projections
FOR EACH STATEMENT
EXECUTE FUNCTION apply_updated_case_law_corpus_index_counts();--> statement-breakpoint

CREATE OR REPLACE FUNCTION subtract_deleted_case_law_corpus_index_counts()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  WITH deltas AS (
    SELECT generation, accounted_index_id AS index_id, count(*)::bigint AS delta
    FROM old_projections
    WHERE accounted_index_id IS NOT NULL
    GROUP BY generation, accounted_index_id
  )
  UPDATE case_law_corpus_index_counts AS counts
  SET marked_indexed = counts.marked_indexed - deltas.delta,
      updated_at = clock_timestamp()
  FROM deltas
  WHERE counts.generation = deltas.generation
    AND counts.index_id = deltas.index_id;

  IF EXISTS (
    SELECT 1
    FROM old_projections AS deleted
    WHERE deleted.accounted_index_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM case_law_corpus_index_backfills AS generation
        WHERE generation.generation = deleted.generation
      )
      AND NOT EXISTS (
        SELECT 1
        FROM case_law_corpus_index_counts AS counts
        WHERE counts.generation = deleted.generation
          AND counts.index_id = deleted.accounted_index_id
      )
  ) THEN
    RAISE EXCEPTION 'case-law corpus index accounting bucket is missing';
  END IF;
  RETURN NULL;
END
$function$;--> statement-breakpoint

CREATE TRIGGER case_law_corpus_index_projection_count_delete
AFTER DELETE ON "case_law_corpus_index_projections"
REFERENCING OLD TABLE AS old_projections
FOR EACH STATEMENT
EXECUTE FUNCTION subtract_deleted_case_law_corpus_index_counts();--> statement-breakpoint

CREATE OR REPLACE FUNCTION seed_case_law_corpus_index_count_backfill()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO case_law_corpus_index_count_backfills (generation, status)
  VALUES (NEW.generation, 'complete')
  ON CONFLICT (generation) DO NOTHING;
  RETURN NEW;
END
$function$;--> statement-breakpoint

CREATE TRIGGER case_law_corpus_index_backfill_seed_count
AFTER INSERT ON "case_law_corpus_index_backfills"
FOR EACH ROW
EXECUTE FUNCTION seed_case_law_corpus_index_count_backfill();
