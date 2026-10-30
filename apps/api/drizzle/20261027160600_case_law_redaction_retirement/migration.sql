-- requires: 20261027160500_case_law_removal_items
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- stella-migration-safety: reviewed security-definer - Replaces the existing trigger owner with a fixed search path and no PUBLIC execute; writes only its decision state, and transaction rollback preserves the prior body.
CREATE OR REPLACE FUNCTION "enqueue_case_law_provision_extraction"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  input_digest bytea := case_law_provision_extraction_input_digest(NEW);
BEGIN
  IF TG_OP = 'UPDATE' AND input_digest = case_law_provision_extraction_input_digest(OLD) AND NEW."redacted_at" IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO "case_law_provision_extraction_scopes" ("country", "language", "status", "generation")
  VALUES (NEW."country", NEW."language", 'retired', 1)
  ON CONFLICT ON CONSTRAINT "case_law_provision_extraction_scopes_pkey" DO NOTHING;

  -- A statement of its own, so it reads the scope row a concurrent insert
  -- won with rather than this statement's snapshot.
  IF NEW."redacted_at" IS NULL AND case_law_provision_extraction_in_scope(NEW."country", NEW."language") THEN
    INSERT INTO "case_law_provision_extractions" AS state (
      "decision_id", "jurisdiction", "desired_input_digest", "lane", "due_at", "enqueue_reason"
    )
    VALUES (
      NEW."id", NEW."country", input_digest,
      case_law_provision_extraction_session_lane(), now(), 'input'
    )
    ON CONFLICT ON CONSTRAINT "case_law_provision_extractions_pkey" DO UPDATE
    SET "jurisdiction" = EXCLUDED."jurisdiction",
        "desired_input_digest" = EXCLUDED."desired_input_digest",
        "lane" = case_law_provision_extraction_merged_lane(state."lane", state."due_at", EXCLUDED."lane"),
        "due_at" = EXCLUDED."due_at",
        "enqueue_reason" = EXCLUDED."enqueue_reason",
        "work_status" = 'eligible',
        "retry_not_before" = NULL,
        "failure_attempts" = 0,
        "transient_attempts" = 0,
        "last_failure_kind" = NULL,
        "last_failure_message" = NULL,
        "blocked_input_digest" = NULL,
        "lease_token" = NULL,
        "lease_expires_at" = NULL,
        "updated_at" = now()
    WHERE state."desired_input_digest" IS DISTINCT FROM EXCLUDED."desired_input_digest";
  ELSE
    -- Out of scope now: a decision with state owes the cleanup of whatever
    -- it published. One without state has nothing to clean up.
    UPDATE "case_law_provision_extractions" AS state
    SET "jurisdiction" = NEW."country",
        "desired_input_digest" = input_digest,
        "lane" = CASE WHEN NEW."redacted_at" IS NOT NULL THEN 'repair' ELSE case_law_provision_extraction_merged_lane(state."lane", state."due_at", 'repair') END,
        "due_at" = now(),
        "enqueue_reason" = 'scope_retired',
        "work_status" = 'eligible',
        "retry_not_before" = NULL,
        "failure_attempts" = 0,
        "transient_attempts" = 0,
        "last_failure_kind" = NULL,
        "last_failure_message" = NULL,
        "blocked_input_digest" = NULL,
        "lease_token" = NULL,
        "lease_expires_at" = NULL,
        "updated_at" = now()
    WHERE state."decision_id" = NEW."id"
      AND (state."desired_input_digest" IS DISTINCT FROM input_digest
        OR (NEW."redacted_at" IS NOT NULL AND (state."lane" IS DISTINCT FROM 'repair' OR state."enqueue_reason" IS DISTINCT FROM 'scope_retired')));
  END IF;

  RETURN NULL;
END;
$$;--> statement-breakpoint

-- stella-migration-safety: reviewed security-definer - Replaces the existing ingestion-only state owner with the same fixed search path and decision locks; writes only named decision states, and transaction rollback preserves the prior body.
CREATE OR REPLACE FUNCTION "ensure_case_law_provision_extraction_state"(
  decision_ids uuid[],
  action text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  written integer;
  retired integer;
BEGIN
  IF action IS NULL OR action NOT IN ('seed', 'reconcile', 'activate', 'retire') THEN
    RAISE EXCEPTION 'unknown provision extraction state action: %', action
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM 1
  FROM "case_law_decisions" decision
  WHERE decision."id" = ANY (decision_ids)
  ORDER BY decision."id"
  FOR NO KEY UPDATE;

  CASE action
    WHEN 'seed' THEN
      INSERT INTO "case_law_provision_extractions" AS state (
        "decision_id", "jurisdiction", "desired_input_digest", "lane", "due_at", "enqueue_reason"
      )
      SELECT decision."id", decision."country",
        case_law_provision_extraction_input_digest(decision), 'backfill', now(), 'seed'
      FROM "case_law_decisions" decision
      WHERE decision."id" = ANY (decision_ids)
        AND decision."redacted_at" IS NULL
        AND case_law_provision_extraction_in_scope(decision."country", decision."language")
      ORDER BY decision."id"
      ON CONFLICT ON CONSTRAINT "case_law_provision_extractions_pkey" DO NOTHING;
    WHEN 'reconcile', 'activate' THEN
      INSERT INTO "case_law_provision_extractions" AS state (
        "decision_id", "jurisdiction", "desired_input_digest", "lane", "due_at", "enqueue_reason"
      )
      SELECT decision."id", decision."country",
        case_law_provision_extraction_input_digest(decision),
        CASE action WHEN 'reconcile' THEN 'repair' ELSE 'backfill' END,
        now(),
        CASE action WHEN 'reconcile' THEN 'reconcile' ELSE 'scope_activated' END
      FROM "case_law_decisions" decision
      WHERE decision."id" = ANY (decision_ids)
        AND decision."redacted_at" IS NULL
        AND case_law_provision_extraction_in_scope(decision."country", decision."language")
      ORDER BY decision."id"
      ON CONFLICT ON CONSTRAINT "case_law_provision_extractions_pkey" DO UPDATE
      SET "jurisdiction" = EXCLUDED."jurisdiction",
          "desired_input_digest" = EXCLUDED."desired_input_digest",
          "lane" = case_law_provision_extraction_merged_lane(state."lane", state."due_at", EXCLUDED."lane"),
          "due_at" = EXCLUDED."due_at",
          "enqueue_reason" = EXCLUDED."enqueue_reason",
          "work_status" = 'eligible',
          "retry_not_before" = NULL,
          "failure_attempts" = 0,
          "transient_attempts" = 0,
          "last_failure_kind" = NULL,
          "last_failure_message" = NULL,
          "blocked_input_digest" = NULL,
          "lease_token" = NULL,
          "lease_expires_at" = NULL,
          "updated_at" = now()
      WHERE CASE action
        WHEN 'reconcile' THEN
          state."desired_input_digest" IS DISTINCT FROM EXCLUDED."desired_input_digest"
        ELSE
          NOT (state."work_status" = 'blocked'
               AND state."blocked_input_digest" IS NOT DISTINCT FROM EXCLUDED."desired_input_digest")
          AND NOT (state."due_at" IS NOT NULL
                   AND state."enqueue_reason" IS NOT DISTINCT FROM 'scope_activated'
                   AND state."desired_input_digest" = EXCLUDED."desired_input_digest")
          AND NOT (state."due_at" IS NULL
                   AND coalesce(state."outcome" IN ('extracted_with_rows', 'extracted_zero'), false)
                   AND state."desired_input_digest" = EXCLUDED."desired_input_digest")
      END;
    WHEN 'retire' THEN written := 0;
  END CASE;

  IF action <> 'retire' THEN
    GET DIAGNOSTICS written = ROW_COUNT;
  END IF;

      UPDATE "case_law_provision_extractions" AS state
      SET "jurisdiction" = decision."country",
          "desired_input_digest" = case_law_provision_extraction_input_digest(decision),
          "lane" = CASE WHEN decision."redacted_at" IS NOT NULL THEN 'repair' ELSE case_law_provision_extraction_merged_lane(state."lane", state."due_at", 'repair') END,
          "due_at" = now(),
          "enqueue_reason" = 'scope_retired',
          "work_status" = 'eligible',
          "retry_not_before" = NULL,
          "failure_attempts" = 0,
          "transient_attempts" = 0,
          "last_failure_kind" = NULL,
          "last_failure_message" = NULL,
          "blocked_input_digest" = NULL,
          "lease_token" = NULL,
          "lease_expires_at" = NULL,
          "updated_at" = now()
      FROM "case_law_decisions" decision
      WHERE state."decision_id" = decision."id"
        AND decision."id" = ANY (decision_ids)
        AND (decision."redacted_at" IS NOT NULL OR (action = 'retire' AND NOT case_law_provision_extraction_in_scope(decision."country", decision."language")))
        AND NOT (state."due_at" IS NOT NULL
                 AND (decision."redacted_at" IS NULL OR state."lane" = 'repair')
                 AND state."enqueue_reason" IS NOT DISTINCT FROM 'scope_retired'
                 AND state."desired_input_digest" = case_law_provision_extraction_input_digest(decision))
        AND NOT (state."due_at" IS NULL
                 AND state."terminal_reason" IS NOT DISTINCT FROM 'out_of_scope'
                 AND state."published_input_digest" IS NOT DISTINCT FROM case_law_provision_extraction_input_digest(decision));

  GET DIAGNOSTICS retired = ROW_COUNT;
  RETURN written + retired;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "enqueue_case_law_provision_extraction"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "ensure_case_law_provision_extraction_state"(uuid[], text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "ensure_case_law_provision_extraction_state"(uuid[], text) TO stella_ingestion;
