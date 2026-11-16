SET LOCAL lock_timeout = '240s';--> statement-breakpoint
SET LOCAL statement_timeout = '250s';--> statement-breakpoint

-- Adding a column needs a moment alone with the table, and a claim holds its row
-- locks for as long as its walk takes. Taking the mutation fence first lets
-- running writers finish and queues new ones, so the moment arrives. The wait is
-- the one a final proof already imposes; the short bounds below cover the DDL.
SELECT "lock_corpus_projection_mutations_exclusive"();--> statement-breakpoint

SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "corpus_index_projection_states"
  ADD COLUMN IF NOT EXISTS "applied_revision_settled" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- Recomputed whenever a row names an applied revision, so an append, a reset or
-- a direct insert cannot carry the previous revision's answer forward.
CREATE OR REPLACE FUNCTION "corpus_projection_state_revision_settled"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW."applied_revision_settled" := NEW."applied_revision" IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public."corpus_index_projection_intents" revision
    WHERE revision."id" = NEW."applied_revision"
      AND revision."status" = 'settled'
  );
  RETURN NEW;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "corpus_projection_state_revision_settled"()
  FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER "corpus_projection_states_revision_settled"
  BEFORE INSERT OR UPDATE OF "applied_revision", "applied_revision_settled"
  ON "corpus_index_projection_states"
  FOR EACH ROW
  EXECUTE FUNCTION "corpus_projection_state_revision_settled"();--> statement-breakpoint

-- Follows a revision into and out of settled. Only those two transitions touch
-- the state row, so the other status changes cost this trigger no write.
CREATE OR REPLACE FUNCTION "corpus_projection_intent_revision_settled"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public."corpus_index_projection_states" state
  SET "applied_revision_settled" = changed."status" = 'settled'
  FROM new_rows changed
  JOIN old_rows previous ON previous."id" = changed."id"
  WHERE changed."status" IS DISTINCT FROM previous."status"
    AND (changed."status" = 'settled' OR previous."status" = 'settled')
    AND state."family" = changed."family"
    AND state."generation" = changed."generation"
    AND state."entity_id" = changed."entity_id"
    AND state."applied_revision" = changed."id";
  RETURN NULL;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "corpus_projection_intent_revision_settled"()
  FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER "corpus_projection_intents_revision_settled"
  AFTER UPDATE ON "corpus_index_projection_intents"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION "corpus_projection_intent_revision_settled"();--> statement-breakpoint

-- The online phase builds corpus_index_projection_states_append_route_idx
-- CONCURRENTLY after this transaction commits, then the repair
-- corpus-projection-applied-revision-settled marks the revisions that settled
-- before these triggers existed.
SELECT 1;
