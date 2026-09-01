SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

CREATE OR REPLACE FUNCTION "guard_corpus_index_projection_history_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  generation_status text;
  rebuild_fenced boolean;
BEGIN
  SELECT generation."status"
  INTO generation_status
  FROM "corpus_index_generations" generation
  WHERE generation."family" = OLD."family"
    AND generation."generation" = OLD."generation";

  IF generation_status NOT IN ('retiring', 'retired') THEN
    RAISE EXCEPTION 'corpus index projection history requires a retiring or retired generation';
  END IF;

  IF generation_status = 'retiring' THEN
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
  END IF;

  IF TG_TABLE_NAME = 'corpus_index_projection_intents'
     AND (to_jsonb(OLD)->>'status') NOT IN ('settled', 'cancelled') THEN
    RAISE EXCEPTION 'nonterminal corpus index projection intent cannot be deleted';
  END IF;

  IF TG_TABLE_NAME = 'corpus_index_projection_states' AND EXISTS (
    SELECT 1
    FROM "corpus_index_projection_intents" intent
    WHERE intent."family" = OLD."family"
      AND intent."generation" = OLD."generation"
      AND intent."entity_id" = OLD."entity_id"
      AND intent."status" NOT IN ('settled', 'cancelled')
  ) THEN
    RAISE EXCEPTION 'projection state with nonterminal intents cannot be deleted';
  END IF;

  RETURN OLD;
END;
$$;--> statement-breakpoint

-- stella-migration-safety: reviewed security-definer - fixed search_path, retiring q09 generation check, exclusive mutation fence, and 10000-entity ceiling preserve least privilege; the dedicated rebuild boundary discards all history only after the caller has removed the physical indexes
CREATE FUNCTION "purge_rebuilding_corpus_index_projection_history"(
  target_family text,
  target_generation text,
  max_entities integer
)
RETURNS TABLE (
  deleted_state_count integer,
  deleted_intent_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  selected_entities uuid[];
  state_count integer;
  intent_count integer;
BEGIN
  IF max_entities IS NULL OR max_entities < 1 OR max_entities > 10000 THEN
    RAISE EXCEPTION 'projection rebuild purge batch must be between 1 and 10000 entities';
  END IF;

  PERFORM public."lock_corpus_projection_mutations_exclusive"();

  PERFORM 1
  FROM public."corpus_index_generations" generation
  WHERE generation."family" = target_family
    AND generation."generation" = target_generation
    AND generation."cluster" = 'q09'
    AND generation."status" = 'retiring'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'projection rebuild purge requires a retiring q09 generation';
  END IF;

  SELECT array_agg(candidate."entity_id" ORDER BY candidate."entity_id")
  INTO selected_entities
  FROM (
    SELECT state."entity_id"
    FROM public."corpus_index_projection_states" state
    WHERE state."family" = target_family
      AND state."generation" = target_generation
    UNION
    SELECT intent."entity_id"
    FROM public."corpus_index_projection_intents" intent
    WHERE intent."family" = target_family
      AND intent."generation" = target_generation
    ORDER BY "entity_id"
    LIMIT max_entities
  ) candidate;

  IF selected_entities IS NULL THEN
    RETURN QUERY SELECT 0, 0;
    RETURN;
  END IF;

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

  RETURN QUERY SELECT state_count, intent_count;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "purge_rebuilding_corpus_index_projection_history"(text, text, integer)
  FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "purge_rebuilding_corpus_index_projection_history"(text, text, integer)
  TO stella_ingestion;
