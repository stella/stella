SET lock_timeout = '3s';
SET statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.case_law_provision_extraction_input_digest(decision public.case_law_decisions)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT public.case_law_provision_extraction_input_digest(
    decision."content_hash",
    decision."decision_date",
    decision."country",
    decision."language",
    decision."redacted_at" IS NULL
  );
$$;

ALTER FUNCTION public.cascade_member_workspace_memberships() SET search_path = pg_catalog, pg_temp;

-- stella-migration-safety: reviewed security-definer - Preserve the existing signature, owner, privileges and behavior while qualifying application references and pinning the trusted search path.
CREATE OR REPLACE FUNCTION public.case_law_provision_extraction_in_scope(decision_country character varying, decision_language character varying)
 RETURNS boolean
 LANGUAGE sql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public."case_law_provision_extraction_scopes" scope
    WHERE scope."country" = decision_country
      AND scope."language" = decision_language
      AND scope."status" = 'active'
  );
$function$;

ALTER FUNCTION public.enforce_organization_member_capacity() SET search_path = pg_catalog, pg_temp;

ALTER FUNCTION public.enforce_organization_member_owner() SET search_path = pg_catalog, pg_temp;

ALTER FUNCTION public.enforce_workspace_contact_capacity() SET search_path = pg_catalog, pg_temp;

ALTER FUNCTION public.enforce_workspace_member_organization_member() SET search_path = pg_catalog, pg_temp;

ALTER FUNCTION public.enforce_workspace_organization_members() SET search_path = pg_catalog, pg_temp;

-- stella-migration-safety: reviewed security-definer - Preserve the existing signature, owner, privileges and behavior while qualifying application references and pinning the trusted search path.
CREATE OR REPLACE FUNCTION public.enqueue_case_law_provision_extraction()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  input_digest bytea := public.case_law_provision_extraction_input_digest(NEW);
BEGIN
  IF TG_OP = 'UPDATE' AND input_digest = public.case_law_provision_extraction_input_digest(OLD) AND NEW."redacted_at" IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO public."case_law_provision_extraction_scopes" ("country", "language", "status", "generation")
  VALUES (NEW."country", NEW."language", 'retired', 1)
  ON CONFLICT ON CONSTRAINT "case_law_provision_extraction_scopes_pkey" DO NOTHING;

  -- A statement of its own, so it reads the scope row a concurrent insert
  -- won with rather than this statement's snapshot.
  IF NEW."redacted_at" IS NULL AND public.case_law_provision_extraction_in_scope(NEW."country", NEW."language") THEN
    INSERT INTO public."case_law_provision_extractions" AS state (
      "decision_id", "jurisdiction", "desired_input_digest", "lane", "due_at", "enqueue_reason"
    )
    VALUES (
      NEW."id", NEW."country", input_digest,
      public.case_law_provision_extraction_session_lane(), now(), 'input'
    )
    ON CONFLICT ON CONSTRAINT "case_law_provision_extractions_pkey" DO UPDATE
    SET "jurisdiction" = EXCLUDED."jurisdiction",
        "desired_input_digest" = EXCLUDED."desired_input_digest",
        "lane" = public.case_law_provision_extraction_merged_lane(state."lane", state."due_at", EXCLUDED."lane"),
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
    UPDATE public."case_law_provision_extractions" AS state
    SET "jurisdiction" = NEW."country",
        "desired_input_digest" = input_digest,
        "lane" = CASE WHEN NEW."redacted_at" IS NOT NULL THEN 'repair' ELSE public.case_law_provision_extraction_merged_lane(state."lane", state."due_at", 'repair') END,
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
$function$;

-- stella-migration-safety: reviewed security-definer - Preserve the existing signature, owner, privileges and behavior while qualifying application references and pinning the trusted search path.
CREATE OR REPLACE FUNCTION public.ensure_case_law_provision_extraction_state(decision_ids uuid[], action text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  written integer;
  retired integer;
BEGIN
  IF action IS NULL OR action NOT IN ('seed', 'reconcile', 'activate', 'retire') THEN
    RAISE EXCEPTION 'unknown provision extraction state action: %', action
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM 1
  FROM public."case_law_decisions" decision
  WHERE decision."id" = ANY (decision_ids)
  ORDER BY decision."id"
  FOR NO KEY UPDATE;

  CASE action
    WHEN 'seed' THEN
      INSERT INTO public."case_law_provision_extractions" AS state (
        "decision_id", "jurisdiction", "desired_input_digest", "lane", "due_at", "enqueue_reason"
      )
      SELECT decision."id", decision."country",
        public.case_law_provision_extraction_input_digest(decision), 'backfill', now(), 'seed'
      FROM public."case_law_decisions" decision
      WHERE decision."id" = ANY (decision_ids)
        AND decision."redacted_at" IS NULL
        AND public.case_law_provision_extraction_in_scope(decision."country", decision."language")
      ORDER BY decision."id"
      ON CONFLICT ON CONSTRAINT "case_law_provision_extractions_pkey" DO NOTHING;
    WHEN 'reconcile', 'activate' THEN
      INSERT INTO public."case_law_provision_extractions" AS state (
        "decision_id", "jurisdiction", "desired_input_digest", "lane", "due_at", "enqueue_reason"
      )
      SELECT decision."id", decision."country",
        public.case_law_provision_extraction_input_digest(decision),
        CASE action WHEN 'reconcile' THEN 'repair' ELSE 'backfill' END,
        now(),
        CASE action WHEN 'reconcile' THEN 'reconcile' ELSE 'scope_activated' END
      FROM public."case_law_decisions" decision
      WHERE decision."id" = ANY (decision_ids)
        AND decision."redacted_at" IS NULL
        AND public.case_law_provision_extraction_in_scope(decision."country", decision."language")
      ORDER BY decision."id"
      ON CONFLICT ON CONSTRAINT "case_law_provision_extractions_pkey" DO UPDATE
      SET "jurisdiction" = EXCLUDED."jurisdiction",
          "desired_input_digest" = EXCLUDED."desired_input_digest",
          "lane" = public.case_law_provision_extraction_merged_lane(state."lane", state."due_at", EXCLUDED."lane"),
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

      UPDATE public."case_law_provision_extractions" AS state
      SET "jurisdiction" = decision."country",
          "desired_input_digest" = public.case_law_provision_extraction_input_digest(decision),
          "lane" = CASE WHEN decision."redacted_at" IS NOT NULL THEN 'repair' ELSE public.case_law_provision_extraction_merged_lane(state."lane", state."due_at", 'repair') END,
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
      FROM public."case_law_decisions" decision
      WHERE state."decision_id" = decision."id"
        AND decision."id" = ANY (decision_ids)
        AND (decision."redacted_at" IS NOT NULL OR (action = 'retire' AND NOT public.case_law_provision_extraction_in_scope(decision."country", decision."language")))
        AND NOT (state."due_at" IS NOT NULL
                 AND (decision."redacted_at" IS NULL OR state."lane" = 'repair')
                 AND state."enqueue_reason" IS NOT DISTINCT FROM 'scope_retired'
                 AND state."desired_input_digest" = public.case_law_provision_extraction_input_digest(decision))
        AND NOT (state."due_at" IS NULL
                 AND state."terminal_reason" IS NOT DISTINCT FROM 'out_of_scope'
                 AND state."published_input_digest" IS NOT DISTINCT FROM public.case_law_provision_extraction_input_digest(decision));

  GET DIAGNOSTICS retired = ROW_COUNT;
  RETURN written + retired;
END;
$function$;

ALTER FUNCTION public.guard_tree_parent() SET search_path = pg_catalog, pg_temp;

ALTER FUNCTION public.legal_reader_annotations_drop_claim_comments() SET search_path = pg_catalog, pg_temp;

ALTER FUNCTION public.legal_reader_annotations_drop_document_marks() SET search_path = pg_catalog, pg_temp;

ALTER FUNCTION public.lock_agent_skill_for_anchor(uuid) SET search_path = pg_catalog, pg_temp;

ALTER FUNCTION public.log_case_law_sitemap_country_generation_change() SET search_path = pg_catalog, pg_temp;

ALTER FUNCTION public.log_case_law_sitemap_decision_change() SET search_path = pg_catalog, pg_temp;

ALTER FUNCTION public.log_case_law_sitemap_source_change() SET search_path = pg_catalog, pg_temp;

ALTER FUNCTION public.pdf_signing_handoff_scope(text) SET search_path = pg_catalog, pg_temp;

ALTER FUNCTION public.pdf_signing_session_scope(uuid,text) SET search_path = pg_catalog, pg_temp;

ALTER FUNCTION public.purge_rebuilding_corpus_index_projection_history(text,text,integer) SET search_path = pg_catalog, pg_temp;

ALTER FUNCTION public.purge_retired_corpus_index_projection_history(text,text,integer) SET search_path = pg_catalog, pg_temp;

-- stella-migration-safety: reviewed security-definer - Preserve the existing signature, owner, privileges and behavior while qualifying application references and pinning the trusted search path.
CREATE OR REPLACE FUNCTION public.read_case_law_provision_pending(requested_country text, requested_language text, empty_content_hashes text[])
 RETURNS TABLE(availability text, pending_count text, oldest_pending_at timestamp with time zone, sampled_at timestamp with time zone, revision integer, scope_generation bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  active_scope record;
  requested_revision integer;
BEGIN
  SELECT scope.status, scope.generation INTO active_scope
  FROM public.case_law_provision_extraction_scopes scope
  WHERE scope.country = requested_country AND scope.language = requested_language;
  IF NOT FOUND OR active_scope.status <> 'active' THEN
    RETURN QUERY SELECT 'scope_inactive'::text, NULL::text, NULL::timestamptz,
      now(), NULL::integer, NULL::bigint;
    RETURN;
  END IF;
  SELECT revisions.desired_revision INTO requested_revision
  FROM public.case_law_provision_extraction_revisions revisions
  WHERE revisions.jurisdiction = requested_country;
  IF requested_revision IS NULL THEN
    RETURN QUERY SELECT 'revision_unavailable'::text, NULL::text, NULL::timestamptz,
      now(), NULL::integer, active_scope.generation;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.case_law_provision_repair_cursors
      WHERE name = 'state-seed' AND completed_at >= (
        SELECT changed_at FROM public.case_law_provision_extraction_revisions
        WHERE jurisdiction = requested_country))
    OR NOT EXISTS (SELECT 1 FROM public.case_law_provision_repair_cursors
      WHERE name = 'scope-bootstrap' AND completed_at IS NOT NULL)
    OR EXISTS (SELECT 1 FROM public.case_law_provision_scope_transitions
      WHERE country = requested_country AND language = requested_language
        AND generation = active_scope.generation AND completed_at IS NULL)
    OR EXISTS (SELECT 1 FROM public.case_law_provision_extractions
      WHERE jurisdiction = requested_country AND due_at IS NOT NULL AND pending_since IS NULL)
  THEN
    RETURN QUERY SELECT 'state_not_seeded'::text, NULL::text, NULL::timestamptz,
      now(), requested_revision, active_scope.generation;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'available'::text, count(*)::text, min(state.pending_since),
    now(), requested_revision, active_scope.generation
  FROM public.case_law_provision_extractions state
  JOIN public.case_law_decisions decision ON decision.id = state.decision_id
  JOIN public.case_law_sources source ON source.id = decision.source_id
  WHERE state.jurisdiction = requested_country AND state.pending_since IS NOT NULL
    AND decision.country = requested_country AND decision.language = requested_language
    AND decision.redacted_at IS NULL AND decision.content_hash IS NOT NULL
    AND NOT (decision.content_hash = ANY (empty_content_hashes))
    AND NOT coalesce(state.payload_class_input_digest = state.desired_input_digest
      AND state.payload_class IN ('empty_envelope', 'unusable'), false)
    AND (source.descriptor IS NULL OR source.descriptor ->> 'allowsRedistribution' = 'true')
    AND jsonb_extract_path_text(decision.metadata, '_stellaPartialObservation', 'isListingOnly') IS DISTINCT FROM 'true';
END;
$function$;

ALTER FUNCTION public.record_agent_skill_revision() SET search_path = pg_catalog, pg_temp;

-- stella-migration-safety: reviewed security-definer - Preserve the existing signature, owner, privileges and behavior while qualifying application references and pinning the trusted search path.
CREATE OR REPLACE FUNCTION public.run_case_law_provision_scope_transition_page(job_country character varying, job_language character varying, job_generation bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  job public."case_law_provision_scope_transitions"%ROWTYPE;
  page_ids uuid[];
  current_ids uuid[];
  page_end uuid;
  scope_generation bigint;
  changed integer;
BEGIN
  SELECT * INTO job
  FROM public."case_law_provision_scope_transitions"
  WHERE "country" = job_country AND "language" = job_language
    AND "generation" = job_generation AND "completed_at" IS NULL;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF job."cursor_decision_id" IS NULL THEN
    SELECT array_agg(id ORDER BY id) INTO page_ids
    FROM (
      SELECT "id"
      FROM public."case_law_decisions"
      WHERE "country" = job_country AND "language" = job_language
      ORDER BY "id"
      LIMIT 50
      FOR NO KEY UPDATE
    ) page;
  ELSE
    SELECT array_agg(id ORDER BY id) INTO page_ids
    FROM (
      SELECT "id"
      FROM public."case_law_decisions"
      WHERE "country" = job_country AND "language" = job_language
        AND "id" > job."cursor_decision_id"
      ORDER BY "id"
      LIMIT 50
      FOR NO KEY UPDATE
    ) page;
  END IF;
  page_end := page_ids[array_length(page_ids, 1)];

  SELECT "generation" INTO scope_generation
  FROM public."case_law_provision_extraction_scopes"
  WHERE "country" = job_country AND "language" = job_language
  FOR SHARE;
  IF scope_generation IS DISTINCT FROM job_generation THEN
    UPDATE public."case_law_provision_scope_transitions"
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
    FROM public."case_law_decisions"
    WHERE "id" = ANY (page_ids)
      AND "country" = job_country AND "language" = job_language;
    IF current_ids IS NOT NULL THEN
      PERFORM public.ensure_case_law_provision_extraction_state(current_ids, job."action");
    END IF;
  END IF;

  UPDATE public."case_law_provision_scope_transitions"
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
$function$;

ALTER FUNCTION public.stella_authorized_workspace_ids(text,text) SET search_path = pg_catalog, pg_temp;

ALTER FUNCTION public.stella_case_law_coverage_summary() SET search_path = pg_catalog, pg_temp;

ALTER FUNCTION public.stella_case_law_coverage_summary_v2() SET search_path = pg_catalog, pg_temp;

ALTER FUNCTION public.stella_create_workspace(uuid,uuid,text,text,text,text,text) SET search_path = pg_catalog, pg_temp;

ALTER FUNCTION public.stella_invoice_access(uuid,text,uuid,uuid,uuid) SET search_path = pg_catalog, pg_temp;

ALTER FUNCTION public.stella_invoice_client_guard() SET search_path = pg_catalog, pg_temp;

ALTER FUNCTION public.stella_matter_invoice_count(uuid) SET search_path = pg_catalog, pg_temp;

ALTER FUNCTION public.stella_matter_reserved_charges(uuid,text,uuid) SET search_path = pg_catalog, pg_temp;

ALTER FUNCTION public.stella_matter_reserved_minutes(uuid,uuid) SET search_path = pg_catalog, pg_temp;

ALTER FUNCTION public.stella_matter_reserved_time(uuid,text,uuid) SET search_path = pg_catalog, pg_temp;
