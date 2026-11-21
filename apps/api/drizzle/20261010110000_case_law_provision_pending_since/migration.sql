SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "case_law_provision_extractions" ADD COLUMN "pending_since" timestamp with time zone;--> statement-breakpoint

GRANT SELECT (pending_since) ON TABLE "case_law_provision_extractions"
TO "stella_public_law_reader";--> statement-breakpoint

CREATE FUNCTION "maintain_case_law_provision_pending_since"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW."due_at" IS NULL THEN
    NEW."pending_since" := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    NEW."pending_since" := NEW."due_at";
  ELSIF NEW."desired_input_digest" IS DISTINCT FROM OLD."desired_input_digest"
    OR OLD."due_at" IS NULL THEN
    NEW."pending_since" := now();
  ELSE
    NEW."pending_since" := coalesce(OLD."pending_since", OLD."due_at");
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "maintain_case_law_provision_pending_since"() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER "case_law_provision_pending_since"
BEFORE INSERT OR UPDATE ON "case_law_provision_extractions"
FOR EACH ROW EXECUTE FUNCTION "maintain_case_law_provision_pending_since"();
--> statement-breakpoint

-- stella-migration-safety: reviewed security-definer - fixed search path, PUBLIC execute revoked; reads only scope metadata and redistributable decision debt
CREATE FUNCTION "read_case_law_provision_pending"(requested_country text, requested_language text, empty_content_hashes text[])
RETURNS TABLE (availability text, pending_count text, oldest_pending_at timestamptz,
  sampled_at timestamptz, revision integer, scope_generation bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  active_scope record;
  requested_revision integer;
BEGIN
  SELECT scope.status, scope.generation INTO active_scope
  FROM case_law_provision_extraction_scopes scope
  WHERE scope.country = requested_country AND scope.language = requested_language;
  IF NOT FOUND OR active_scope.status <> 'active' THEN
    RETURN QUERY SELECT 'scope_inactive'::text, NULL::text, NULL::timestamptz,
      now(), NULL::integer, NULL::bigint;
    RETURN;
  END IF;
  SELECT revisions.desired_revision INTO requested_revision
  FROM case_law_provision_extraction_revisions revisions
  WHERE revisions.jurisdiction = requested_country;
  IF requested_revision IS NULL THEN
    RETURN QUERY SELECT 'revision_unavailable'::text, NULL::text, NULL::timestamptz,
      now(), NULL::integer, active_scope.generation;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM case_law_provision_repair_cursors
      WHERE name = 'state-seed' AND completed_at >= (
        SELECT changed_at FROM case_law_provision_extraction_revisions
        WHERE jurisdiction = requested_country))
    OR NOT EXISTS (SELECT 1 FROM case_law_provision_repair_cursors
      WHERE name = 'scope-bootstrap' AND completed_at IS NOT NULL)
    OR EXISTS (SELECT 1 FROM case_law_provision_scope_transitions
      WHERE country = requested_country AND language = requested_language
        AND generation = active_scope.generation AND completed_at IS NULL)
    OR EXISTS (SELECT 1 FROM case_law_provision_extractions
      WHERE jurisdiction = requested_country AND due_at IS NOT NULL AND pending_since IS NULL)
  THEN
    RETURN QUERY SELECT 'state_not_seeded'::text, NULL::text, NULL::timestamptz,
      now(), requested_revision, active_scope.generation;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'available'::text, count(*)::text, min(state.pending_since),
    now(), requested_revision, active_scope.generation
  FROM case_law_provision_extractions state
  JOIN case_law_decisions decision ON decision.id = state.decision_id
  JOIN case_law_sources source ON source.id = decision.source_id
  WHERE state.jurisdiction = requested_country AND state.pending_since IS NOT NULL
    AND decision.country = requested_country AND decision.language = requested_language
    AND decision.redacted_at IS NULL AND decision.content_hash IS NOT NULL
    AND NOT (decision.content_hash = ANY (empty_content_hashes))
    AND NOT coalesce(state.payload_class_input_digest = state.desired_input_digest
      AND state.payload_class IN ('empty_envelope', 'unusable'), false)
    AND (source.descriptor IS NULL OR source.descriptor ->> 'allowsRedistribution' = 'true')
    AND jsonb_extract_path_text(decision.metadata, '_stellaPartialObservation', 'isListingOnly') IS DISTINCT FROM 'true';
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "read_case_law_provision_pending"(text, text, text[]) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "read_case_law_provision_pending"(text, text, text[])
TO "stella", "stella_ingestion", "stella_public_law_reader";
