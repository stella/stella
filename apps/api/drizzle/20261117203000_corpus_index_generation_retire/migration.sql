-- requires: 20261117160000_case_law_content_changed_at
SET LOCAL lock_timeout = '240s';--> statement-breakpoint
SET LOCAL statement_timeout = '250s';--> statement-breakpoint

-- The triggers below need a moment alone with the projection tables, and a
-- projection writer holds its row locks until it commits. Taking the
-- mutation fence first lets running writers finish and queues new ones, so
-- the moment arrives; the short bounds below cover the DDL itself.
SELECT "lock_corpus_projection_mutations_exclusive"();--> statement-breakpoint

SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Who retired a generation, when and why. The retire command writes all three
-- in the transaction that moves the generation to retired; a generation
-- retired before the command existed keeps them null.
ALTER TABLE "corpus_index_generations"
  ADD COLUMN IF NOT EXISTS "retired_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "retire_actor" varchar(128),
  ADD COLUMN IF NOT EXISTS "retire_reason" varchar(2048);--> statement-breakpoint

-- Retired stays terminal (unchanged), and the retire receipt is written once,
-- whole, with the move to retired, and never changes after.
CREATE OR REPLACE FUNCTION "guard_retired_corpus_index_generation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" = 'retired' AND NEW."status" <> 'retired' THEN
    RAISE EXCEPTION 'retired corpus index generation is terminal';
  END IF;
  IF OLD."retired_at" IS NOT NULL
     AND (NEW."retired_at", NEW."retire_actor", NEW."retire_reason")
         IS DISTINCT FROM (OLD."retired_at", OLD."retire_actor", OLD."retire_reason") THEN
    RAISE EXCEPTION 'corpus index generation retire receipt is immutable';
  END IF;
  -- IS NOT TRUE, not NOT: a missing part makes the check null, and a null
  -- must refuse the receipt too.
  IF OLD."retired_at" IS NULL
     AND (NEW."retired_at" IS NOT NULL OR NEW."retire_actor" IS NOT NULL OR NEW."retire_reason" IS NOT NULL)
     AND (
       OLD."status" <> 'retired'
       AND NEW."status" = 'retired'
       AND NEW."retired_at" IS NOT NULL
       AND NEW."retire_actor" ~ '^[a-z0-9][a-z0-9:._@/-]*$'
       AND length(btrim(NEW."retire_reason")) > 0
     ) IS NOT TRUE THEN
    RAISE EXCEPTION 'corpus index generation retire receipt is written whole, with the move to retired';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- A retired generation is owed nothing: no writer may give it a projection
-- state or a revision, or change one it holds, from the commit that retired
-- it on. Lifecycle changes take the exclusive mutation fence and every
-- projection statement takes its shared side first, so a writer either
-- committed before the retire or reads the retired status here.
CREATE FUNCTION "refuse_retired_corpus_index_projection_write"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public."corpus_index_generations" generation
    WHERE generation."family" = NEW."family"
      AND generation."generation" = NEW."generation"
      AND generation."status" = 'retired'
  ) THEN
    RAISE EXCEPTION 'corpus index generation %/% is retired and takes no projection writes', NEW."family", NEW."generation";
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "refuse_retired_corpus_index_projection_write"()
  FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER "corpus_index_projection_states_retired_generation_guard"
  BEFORE INSERT OR UPDATE ON "corpus_index_projection_states"
  FOR EACH ROW
  EXECUTE FUNCTION "refuse_retired_corpus_index_projection_write"();--> statement-breakpoint

CREATE TRIGGER "corpus_index_projection_intents_retired_generation_guard"
  BEFORE INSERT OR UPDATE ON "corpus_index_projection_intents"
  FOR EACH ROW
  EXECUTE FUNCTION "refuse_retired_corpus_index_projection_write"();--> statement-breakpoint

-- A retired generation's history may go whole. Nothing serves it or projects
-- it again, and the retire command deletes its physical indexes, so an
-- unfinished revision owes no cleanup. A retiring generation (a rebuild in
-- progress) still deletes only under the rebuild fence.
CREATE OR REPLACE FUNCTION public."guard_corpus_index_projection_history_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  generation_status text;
  rebuild_fenced boolean;
BEGIN
  SELECT generation."status"
  INTO generation_status
  FROM public."corpus_index_generations" generation
  WHERE generation."family" = OLD."family"
    AND generation."generation" = OLD."generation";

  IF generation_status = 'retired' THEN
    RETURN OLD;
  END IF;

  IF generation_status IS DISTINCT FROM 'retiring' THEN
    RAISE EXCEPTION 'corpus index projection history requires a retiring or retired generation';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_locks held
    WHERE held."locktype" = 'advisory'
      AND held."pid" = pg_catalog.pg_backend_pid()
      AND held."classid" = 1937007986::oid
      AND held."objid" = 1::oid
      AND held."objsubid" = 2
      AND held."mode" = 'ExclusiveLock'
      AND held."granted"
  ) INTO rebuild_fenced;
  IF NOT rebuild_fenced THEN
    RAISE EXCEPTION 'retiring corpus index projection history requires the rebuild fence';
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint

-- One page of a retired generation's history: the first `max_entities`
-- entities after `after_entity` (null: from the start) that hold a state or a
-- revision, deleted whole. The caller walks the cursor forward; a crashed walk
-- starts again from the start and finds only what is left.
-- stella-migration-safety: reviewed security-definer - trusted search_path, retired-generation check, a 10000-entity ceiling and an entity cursor bound every call to one page of one retired generation's history; PUBLIC execute is revoked below
CREATE FUNCTION public."purge_retired_corpus_index_generation_page"(
  target_family text,
  target_generation text,
  after_entity uuid,
  max_entities integer
)
RETURNS TABLE (
  deleted_state_count integer,
  deleted_intent_count integer,
  last_entity uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  selected_entities uuid[];
  state_count integer;
  intent_count integer;
  lower_bound uuid := coalesce(after_entity, '00000000-0000-0000-0000-000000000000'::uuid);
BEGIN
  IF max_entities IS NULL OR max_entities < 1 OR max_entities > 10000 THEN
    RAISE EXCEPTION 'retired history purge page must be between 1 and 10000 entities';
  END IF;

  PERFORM 1
  FROM public."corpus_index_generations" generation
  WHERE generation."family" = target_family
    AND generation."generation" = target_generation
    AND generation."status" = 'retired'
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'retired history purge requires a retired generation';
  END IF;

  SELECT array_agg(candidate."entity_id" ORDER BY candidate."entity_id")
  INTO selected_entities
  FROM (
    SELECT page."entity_id"
    FROM (
      (
        SELECT state."entity_id"
        FROM public."corpus_index_projection_states" state
        WHERE state."family" = target_family
          AND state."generation" = target_generation
          AND state."entity_id" > lower_bound
        ORDER BY state."entity_id"
        LIMIT max_entities
      )
      UNION
      (
        SELECT intent."entity_id"
        FROM public."corpus_index_projection_intents" intent
        WHERE intent."family" = target_family
          AND intent."generation" = target_generation
          AND intent."entity_id" > lower_bound
        ORDER BY intent."entity_id"
        LIMIT max_entities
      )
    ) page
    ORDER BY page."entity_id"
    LIMIT max_entities
  ) candidate;

  IF selected_entities IS NULL THEN
    RETURN QUERY SELECT 0, 0, NULL::uuid;
    RETURN;
  END IF;

  -- States first: a state names its applied revision, never the reverse.
  DELETE FROM public."corpus_index_projection_states" state
  WHERE state."family" = target_family
    AND state."generation" = target_generation
    AND state."entity_id" = ANY(selected_entities);
  GET DIAGNOSTICS state_count = ROW_COUNT;

  DELETE FROM public."corpus_index_projection_intents" intent
  WHERE intent."family" = target_family
    AND intent."generation" = target_generation
    AND intent."entity_id" = ANY(selected_entities);
  GET DIAGNOSTICS intent_count = ROW_COUNT;

  RETURN QUERY SELECT
    state_count,
    intent_count,
    selected_entities[pg_catalog.array_upper(selected_entities, 1)];
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public."purge_retired_corpus_index_generation_page"(text, text, uuid, integer)
  FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public."purge_retired_corpus_index_generation_page"(text, text, uuid, integer)
  TO stella_ingestion;--> statement-breakpoint

-- Superseded by the page above, which also takes the unfinished revisions a
-- retired generation leaves; no release calls it.
-- stella-migration-safety: reviewed drop-object - no release calls this function; the page function above replaces it
DROP FUNCTION IF EXISTS public."purge_retired_corpus_index_projection_history"(text, text, integer);
