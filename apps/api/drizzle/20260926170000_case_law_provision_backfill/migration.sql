SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- A committed page advances its cursor in the same transaction as its writes.
CREATE TABLE "case_law_provision_repair_cursors" (
  "name" text PRIMARY KEY,
  "cursor_decision_id" uuid,
  "completed_at" timestamptz,
  CONSTRAINT "case_law_provision_repair_cursors_name_values"
    CHECK ("name" IN ('scope-bootstrap', 'state-seed'))
);--> statement-breakpoint
ALTER TABLE "case_law_provision_repair_cursors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_provision_repair_cursors" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Row security is forced, so the owner-run repair needs a policy too; the
-- owner role is named per deployment, and privileges decide access.
-- stella-migration-safety: reviewed permissive-policy - privileges, not this policy, decide access: the owner holds them all and every privilege is revoked from stella below
CREATE POLICY "case_law_provision_extraction_owner_access" ON "case_law_provision_repair_cursors"
  AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "case_law_provision_repair_cursors" FROM stella;--> statement-breakpoint

-- The transition page is callable by the corpus runner. It takes decision
-- locks before the scope lock, then lets the state writer take state locks.
-- The cursor compare-and-swap makes simultaneous runners retry the same page.
-- stella-migration-safety: reviewed security-definer - fixed search path, PUBLIC execute revoked below; only a registered job may select its scope and the existing state writer owns state changes
CREATE FUNCTION "run_case_law_provision_scope_transition_page"(
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

  SELECT array_agg(id ORDER BY id) INTO page_ids
  FROM (
    SELECT "id"
    FROM "case_law_decisions"
    WHERE "country" = job_country AND "language" = job_language
      AND (job."cursor_decision_id" IS NULL OR "id" > job."cursor_decision_id")
    ORDER BY "id"
    LIMIT 50
    FOR NO KEY UPDATE
  ) page;
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
  TO "stella_ingestion";--> statement-breakpoint
