SET LOCAL lock_timeout = '5s';--> statement-breakpoint

SET LOCAL statement_timeout = '30s';--> statement-breakpoint

-- The public-read predicate is checked against its TypeScript owner by the DB tests.
CREATE FUNCTION "case_law_statute_citation_is_published"(metadata jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public, pg_temp
AS $$ SELECT jsonb_extract_path_text(metadata, '_stellaPartialObservation', 'isListingOnly') is distinct from 'true' $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "sync_case_law_statute_citation_membership"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  citation_source_id uuid;
  citation_country text;
  citation_published boolean;
BEGIN
  -- Serialize projection reads with decision transitions and the bounded repair.
  -- NO KEY UPDATE remains compatible with the citation foreign key's KEY SHARE.
  PERFORM 1 FROM "case_law_decisions"
  WHERE "id" IN (
    CASE WHEN TG_OP <> 'INSERT' THEN OLD."decision_id" END,
    CASE WHEN TG_OP <> 'DELETE' THEN NEW."decision_id" END
  )
  ORDER BY "id" FOR NO KEY UPDATE;
  IF TG_OP IN ('DELETE', 'UPDATE') AND OLD."work_eli" IS NOT NULL THEN
    DELETE FROM "case_law_statute_citation_memberships" membership
    WHERE membership."decision_id" = OLD."decision_id"
      AND membership."jurisdiction" = OLD."jurisdiction"
      AND membership."work_eli" = OLD."work_eli"
      AND (
        (
          membership."target_type" = 'work'
          AND NOT EXISTS (
            SELECT 1 FROM "case_law_provision_citations" citation
            WHERE citation."decision_id" = OLD."decision_id"
              AND citation."jurisdiction" = OLD."jurisdiction"
              AND citation."work_eli" = OLD."work_eli"
          )
        )
        OR (
          membership."target_type" = 'provision'
          AND membership."anchor" = OLD."anchor"
          AND NOT EXISTS (
            SELECT 1 FROM "case_law_provision_citations" citation
            WHERE citation."decision_id" = OLD."decision_id"
              AND citation."jurisdiction" = OLD."jurisdiction"
              AND citation."work_eli" = OLD."work_eli"
              AND citation."anchor" = OLD."anchor"
          )
        )
      );
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW."work_eli" IS NOT NULL THEN
    SELECT decision."source_id", decision."country",
      case_law_statute_citation_is_published(decision."metadata")
    INTO STRICT citation_source_id, citation_country, citation_published
    FROM "case_law_decisions" decision
    WHERE decision."id" = NEW."decision_id";

    IF NOT citation_published OR citation_country <> NEW."jurisdiction" THEN
      RETURN NEW;
    END IF;

    INSERT INTO "case_law_statute_citation_memberships" (
      "decision_id", "source_id", "jurisdiction", "work_eli", "target_type", "anchor"
    ) VALUES (
      NEW."decision_id", citation_source_id, NEW."jurisdiction", NEW."work_eli", 'work', ''
    )
    ON CONFLICT DO NOTHING;

    IF NEW."anchor" <> '' THEN
      INSERT INTO "case_law_statute_citation_memberships" (
        "decision_id", "source_id", "jurisdiction", "work_eli", "target_type", "anchor"
      ) VALUES (
        NEW."decision_id", citation_source_id, NEW."jurisdiction", NEW."work_eli", 'provision', NEW."anchor"
      )
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- One per-decision repair owns the rebuild used by transitions and maintenance.
CREATE FUNCTION "refresh_case_law_statute_citation_memberships"(target_decision_id uuid)
RETURNS void LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  target_source_id uuid;
  target_country text;
  target_published boolean;
BEGIN
  SELECT source_id, country, case_law_statute_citation_is_published(metadata)
  INTO STRICT target_source_id, target_country, target_published
  FROM case_law_decisions WHERE id = target_decision_id FOR NO KEY UPDATE;

  -- Preserve correct memberships: replay should not rewrite every citation bucket.
  DELETE FROM case_law_statute_citation_memberships membership
  WHERE membership.decision_id = target_decision_id AND (
    NOT target_published
    OR membership.source_id <> target_source_id
    OR membership.jurisdiction <> target_country
    OR NOT EXISTS (
      SELECT 1 FROM case_law_provision_citations citation
      WHERE citation.decision_id = target_decision_id
        AND citation.jurisdiction = membership.jurisdiction
        AND citation.work_eli = membership.work_eli
        AND (membership.target_type = 'work' OR citation.anchor = membership.anchor)
    )
  );
  IF NOT target_published THEN
    RETURN;
  END IF;

  INSERT INTO case_law_statute_citation_memberships (
    decision_id, source_id, jurisdiction, work_eli, target_type, anchor
  )
  SELECT decision_id, target_source_id, jurisdiction, work_eli, 'work' AS target_type, '' AS anchor
  FROM case_law_provision_citations
  WHERE decision_id = target_decision_id AND jurisdiction = target_country
    AND work_eli IS NOT NULL
  UNION
  SELECT decision_id, target_source_id, jurisdiction, work_eli, 'provision', anchor
  FROM case_law_provision_citations
  WHERE decision_id = target_decision_id AND jurisdiction = target_country
    AND work_eli IS NOT NULL AND anchor <> ''
  ORDER BY jurisdiction, work_eli, target_type, anchor
  ON CONFLICT DO NOTHING;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "sync_case_law_statute_citation_membership_source"()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM refresh_case_law_statute_citation_memberships(NEW.id);
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - Replace the source-only trigger atomically with the full publication transition trigger.
DROP TRIGGER "case_law_decision_statute_citation_membership_source" ON "case_law_decisions";--> statement-breakpoint

CREATE TRIGGER "case_law_decision_statute_citation_membership_source"
AFTER UPDATE OF "source_id", "country", "metadata" ON "case_law_decisions"
FOR EACH ROW
WHEN (
  OLD.source_id IS DISTINCT FROM NEW.source_id
  OR OLD.country IS DISTINCT FROM NEW.country
  OR case_law_statute_citation_is_published(OLD.metadata)
     IS DISTINCT FROM case_law_statute_citation_is_published(NEW.metadata)
)
EXECUTE FUNCTION "sync_case_law_statute_citation_membership_source"();--> statement-breakpoint

-- Existing counts stay hidden until the checkpointed maintenance script repairs them.
UPDATE case_law_statute_citation_count_state
SET status = 'building', cursor_decision_id = NULL, updated_at = now()
WHERE key = 'global' AND (
  EXISTS (SELECT 1 FROM case_law_provision_citations)
  OR EXISTS (SELECT 1 FROM case_law_statute_citation_memberships)
);
