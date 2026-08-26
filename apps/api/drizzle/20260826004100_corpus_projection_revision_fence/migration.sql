SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A generation-local mutation clock lets a standing engine census prove that
-- its PostgreSQL desired-state snapshot remained current through promotion.
ALTER TABLE "corpus_index_generations"
  ADD COLUMN "projection_revision" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint

ALTER TABLE "corpus_index_generations"
  ADD CONSTRAINT "corpus_index_generations_projection_revision_positive"
  CHECK ("projection_revision" > 0) NOT VALID;--> statement-breakpoint

-- stella-migration-safety: reviewed security-definer - trigger-only function has a fixed search path and PUBLIC execute is revoked below; rollback drops its triggers and function
CREATE FUNCTION "bump_corpus_projection_revision_from_new"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public."corpus_index_generations" generation
     SET "projection_revision" = generation."projection_revision" + 1
    FROM (
      SELECT DISTINCT "family", "generation"
        FROM new_rows
    ) changed
   WHERE generation."family" = changed."family"
     AND generation."generation" = changed."generation";
  RETURN NULL;
END;
$$;--> statement-breakpoint

-- stella-migration-safety: reviewed security-definer - trigger-only function has a fixed search path and PUBLIC execute is revoked below; rollback drops its triggers and function
CREATE FUNCTION "bump_corpus_projection_revision_from_old"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public."corpus_index_generations" generation
     SET "projection_revision" = generation."projection_revision" + 1
    FROM (
      SELECT DISTINCT "family", "generation"
        FROM old_rows
    ) changed
   WHERE generation."family" = changed."family"
     AND generation."generation" = changed."generation";
  RETURN NULL;
END;
$$;--> statement-breakpoint

-- stella-migration-safety: reviewed security-definer - trigger-only function has a fixed search path and PUBLIC execute is revoked below; rollback drops its triggers and function
CREATE FUNCTION "bump_corpus_projection_revision_from_update"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public."corpus_index_generations" generation
     SET "projection_revision" = generation."projection_revision" + 1
    FROM (
      SELECT "family", "generation" FROM old_rows
      UNION
      SELECT "family", "generation" FROM new_rows
    ) changed
   WHERE generation."family" = changed."family"
     AND generation."generation" = changed."generation";
  RETURN NULL;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "bump_corpus_projection_revision_from_new"()
  FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "bump_corpus_projection_revision_from_old"()
  FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "bump_corpus_projection_revision_from_update"()
  FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER "corpus_projection_states_revision_insert"
  AFTER INSERT ON "corpus_index_projection_states"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION "bump_corpus_projection_revision_from_new"();--> statement-breakpoint

CREATE TRIGGER "corpus_projection_states_revision_update"
  AFTER UPDATE ON "corpus_index_projection_states"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION "bump_corpus_projection_revision_from_update"();--> statement-breakpoint

CREATE TRIGGER "corpus_projection_states_revision_delete"
  AFTER DELETE ON "corpus_index_projection_states"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION "bump_corpus_projection_revision_from_old"();--> statement-breakpoint

CREATE TRIGGER "corpus_projection_intents_revision_insert"
  AFTER INSERT ON "corpus_index_projection_intents"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION "bump_corpus_projection_revision_from_new"();--> statement-breakpoint

CREATE TRIGGER "corpus_projection_intents_revision_update"
  AFTER UPDATE ON "corpus_index_projection_intents"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION "bump_corpus_projection_revision_from_update"();--> statement-breakpoint

CREATE TRIGGER "corpus_projection_intents_revision_delete"
  AFTER DELETE ON "corpus_index_projection_intents"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION "bump_corpus_projection_revision_from_old"();
