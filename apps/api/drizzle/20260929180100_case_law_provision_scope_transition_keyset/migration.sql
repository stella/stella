SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- The transition page reads its first page and the pages after its cursor
-- with separate statements. A plan cached for the function cannot use an
-- optional bound (`cursor IS NULL OR id > cursor`) as an index condition, so
-- every page would walk the scope from its start. Signature, locking order,
-- cursor compare-and-swap and result are unchanged.
-- stella-migration-safety: reviewed security-definer - replaces the function's body only; fixed search path, PUBLIC execute revoked and granted to the corpus runner only, as before
CREATE OR REPLACE FUNCTION "run_case_law_provision_scope_transition_page"(
  job_country varchar,
  job_language varchar,
  job_generation bigint
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  job "case_law_provision_scope_transitions"%ROWTYPE;
  page_ids uuid[];
  current_ids uuid[];
  page_end uuid;
  scope_generation bigint;
  changed integer;
BEGIN
  SELECT * INTO job
  FROM "case_law_provision_scope_transitions"
  WHERE "country" = job_country AND "language" = job_language
    AND "generation" = job_generation AND "completed_at" IS NULL;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF job."cursor_decision_id" IS NULL THEN
    SELECT array_agg(id ORDER BY id) INTO page_ids
    FROM (
      SELECT "id"
      FROM "case_law_decisions"
      WHERE "country" = job_country AND "language" = job_language
      ORDER BY "id"
      LIMIT 50
      FOR NO KEY UPDATE
    ) page;
  ELSE
    SELECT array_agg(id ORDER BY id) INTO page_ids
    FROM (
      SELECT "id"
      FROM "case_law_decisions"
      WHERE "country" = job_country AND "language" = job_language
        AND "id" > job."cursor_decision_id"
      ORDER BY "id"
      LIMIT 50
      FOR NO KEY UPDATE
    ) page;
  END IF;
  page_end := page_ids[array_length(page_ids, 1)];

  SELECT "generation" INTO scope_generation
  FROM "case_law_provision_extraction_scopes"
  WHERE "country" = job_country AND "language" = job_language
  FOR SHARE;
  IF scope_generation IS DISTINCT FROM job_generation THEN
    UPDATE "case_law_provision_scope_transitions"
    SET "completed_at" = now()
    WHERE "country" = job_country AND "language" = job_language
      AND "generation" = job_generation AND "completed_at" IS NULL
      AND "cursor_decision_id" IS NOT DISTINCT FROM job."cursor_decision_id";
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed <> 1 THEN
      RAISE EXCEPTION 'provision scope transition cursor changed'
        USING ERRCODE = 'serialization_failure';
    END IF;
    RETURN false;
  END IF;

  IF page_end IS NOT NULL THEN
    SELECT array_agg("id" ORDER BY "id") INTO current_ids
    FROM "case_law_decisions"
    WHERE "id" = ANY (page_ids)
      AND "country" = job_country AND "language" = job_language;
    IF current_ids IS NOT NULL THEN
      PERFORM ensure_case_law_provision_extraction_state(current_ids, job."action");
    END IF;
  END IF;

  UPDATE "case_law_provision_scope_transitions"
  SET "cursor_decision_id" = coalesce(page_end, job."cursor_decision_id"),
      "completed_at" = CASE WHEN page_end IS NULL THEN now() ELSE NULL END
  WHERE "country" = job_country AND "language" = job_language
    AND "generation" = job_generation AND "completed_at" IS NULL
    AND "cursor_decision_id" IS NOT DISTINCT FROM job."cursor_decision_id";
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN
    RAISE EXCEPTION 'provision scope transition cursor changed'
      USING ERRCODE = 'serialization_failure';
  END IF;
  RETURN page_end IS NOT NULL;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "run_case_law_provision_scope_transition_page"(varchar, varchar, bigint)
  FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "run_case_law_provision_scope_transition_page"(varchar, varchar, bigint)
  TO "stella_ingestion";
