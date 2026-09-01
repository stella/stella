SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Projection revisions are append-only transaction observations. They avoid
-- turning the generation registry into a row-lock mutex for every writer.
CREATE TABLE "corpus_index_projection_revisions" (
  "family" text NOT NULL,
  "generation" varchar(32) NOT NULL,
  "revision" bigint NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "corpus_index_projection_revisions_pkey"
    PRIMARY KEY ("family", "generation", "revision"),
  CONSTRAINT "corpus_index_projection_revisions_generation_fk"
    FOREIGN KEY ("family", "generation")
    REFERENCES "corpus_index_generations" ("family", "generation")
    ON DELETE CASCADE,
  CONSTRAINT "corpus_index_projection_revisions_family_values"
    CHECK ("family" IN ('case_law','legislation')),
  CONSTRAINT "corpus_index_projection_revisions_revision_positive"
    CHECK ("revision" > 0)
);--> statement-breakpoint

ALTER TABLE "corpus_index_projection_revisions"
  ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_global_access"
  ON "corpus_index_projection_revisions"
  AS PERMISSIVE FOR SELECT TO stella USING (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access"
  ON "corpus_index_projection_revisions"
  AS PERMISSIVE FOR ALL TO stella_ingestion
  USING (true) WITH CHECK (true);--> statement-breakpoint

GRANT SELECT ON TABLE "corpus_index_projection_revisions" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE "corpus_index_projection_revisions"
  TO stella_ingestion;--> statement-breakpoint

-- Writers share one transaction lock. Final proof and promotion take its
-- exclusive counterpart, which waits for in-flight writers and blocks new
-- projection mutations until their transaction commits.
CREATE FUNCTION "lock_corpus_projection_mutations_shared"()
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT pg_catalog.pg_advisory_xact_lock_shared(1937007986, 1);
$$;--> statement-breakpoint

CREATE FUNCTION "lock_corpus_projection_mutations_exclusive"()
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT pg_catalog.pg_advisory_xact_lock(1937007986, 1);
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "lock_corpus_projection_mutations_shared"()
  FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "lock_corpus_projection_mutations_exclusive"()
  FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "lock_corpus_projection_mutations_shared"()
  TO stella_ingestion;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "lock_corpus_projection_mutations_exclusive"()
  TO stella_ingestion;--> statement-breakpoint

CREATE FUNCTION "fence_corpus_projection_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public."lock_corpus_projection_mutations_shared"();
  RETURN NULL;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "fence_corpus_projection_mutation"()
  FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER "corpus_projection_states_mutation_fence"
  BEFORE INSERT OR UPDATE OR DELETE ON "corpus_index_projection_states"
  FOR EACH STATEMENT
  EXECUTE FUNCTION "fence_corpus_projection_mutation"();--> statement-breakpoint

CREATE TRIGGER "corpus_projection_intents_mutation_fence"
  BEFORE INSERT OR UPDATE OR DELETE ON "corpus_index_projection_intents"
  FOR EACH STATEMENT
  EXECUTE FUNCTION "fence_corpus_projection_mutation"();--> statement-breakpoint

-- Generation lifecycle changes are the opposing side of the same fence. The
-- trigger keeps direct SQL transitions from overtaking an in-flight writer.
CREATE FUNCTION "fence_corpus_projection_generation_lifecycle"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public."lock_corpus_projection_mutations_exclusive"();
  RETURN NULL;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "fence_corpus_projection_generation_lifecycle"()
  FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER "corpus_index_generations_projection_lifecycle_fence"
  BEFORE INSERT OR UPDATE OR DELETE ON "corpus_index_generations"
  FOR EACH STATEMENT
  EXECUTE FUNCTION "fence_corpus_projection_generation_lifecycle"();--> statement-breakpoint

-- Existing statement triggers keep their names, but now append the current
-- transaction id once per changed generation instead of updating one shared
-- registry row. ON CONFLICT folds multiple statements in one transaction.
CREATE OR REPLACE FUNCTION "bump_corpus_projection_revision_from_new"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public."corpus_index_projection_revisions"
    ("family", "generation", "revision")
  SELECT DISTINCT
    changed."family",
    changed."generation",
    pg_catalog.pg_current_xact_id()::text::bigint
  FROM new_rows changed
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "bump_corpus_projection_revision_from_old"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public."corpus_index_projection_revisions"
    ("family", "generation", "revision")
  SELECT DISTINCT
    changed."family",
    changed."generation",
    pg_catalog.pg_current_xact_id()::text::bigint
  FROM old_rows changed
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "bump_corpus_projection_revision_from_update"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public."corpus_index_projection_revisions"
    ("family", "generation", "revision")
  SELECT DISTINCT
    changed."family",
    changed."generation",
    pg_catalog.pg_current_xact_id()::text::bigint
  FROM (
    SELECT "family", "generation" FROM old_rows
    UNION
    SELECT "family", "generation" FROM new_rows
  ) changed
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;--> statement-breakpoint

-- New generation registration creates the initial readable revision.
CREATE FUNCTION "seed_corpus_projection_revision"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public."corpus_index_projection_revisions"
    ("family", "generation", "revision")
  VALUES (
    NEW."family",
    NEW."generation",
    pg_catalog.pg_current_xact_id()::text::bigint
  );
  RETURN NULL;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "seed_corpus_projection_revision"()
  FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER "corpus_index_generations_projection_revision_seed"
  AFTER INSERT ON "corpus_index_generations"
  FOR EACH ROW
  EXECUTE FUNCTION "seed_corpus_projection_revision"();--> statement-breakpoint

-- stella-migration-safety: reviewed insert-select - the source is the closed, single-digit generation registry; rollback drops the new table
INSERT INTO "corpus_index_projection_revisions"
  ("family", "generation", "revision")
SELECT
  generation."family",
  generation."generation",
  pg_catalog.pg_current_xact_id()::text::bigint
FROM "corpus_index_generations" generation
ON CONFLICT DO NOTHING;
