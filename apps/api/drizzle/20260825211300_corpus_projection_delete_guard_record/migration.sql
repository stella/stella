SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

CREATE OR REPLACE FUNCTION "guard_corpus_index_projection_history_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "corpus_index_generations" generation
    WHERE generation."family" = OLD."family"
      AND generation."generation" = OLD."generation"
      AND generation."status" = 'retired'
  ) THEN
    RAISE EXCEPTION 'corpus index projection history requires a retired generation';
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
$$;
