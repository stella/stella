-- requires: 20261010212100_case_law_publication_filter
SET LOCAL lock_timeout = '5s';--> statement-breakpoint

SET LOCAL statement_timeout = '30s';--> statement-breakpoint

-- The anchor and every provision it sits under, outermost first: the
-- prefixes ending before the citing grammar's level separator. Mirrors
-- `provisionAnchorLineage` in apps/api/src/lib/case-law/provision-anchor-lineage.ts;
-- a jurisdiction without a grammar keeps its anchors opaque.
CREATE OR REPLACE FUNCTION "case_law_provision_anchor_lineage"(target_jurisdiction text, target_anchor text)
RETURNS text[] LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
SELECT CASE
  WHEN target_anchor = '' THEN ARRAY[]::text[]
  WHEN split.separator IS NULL THEN ARRAY[target_anchor]
  ELSE ARRAY(
    SELECT array_to_string(split.parts[1:depth], split.separator)
    FROM generate_series(1, cardinality(split.parts)) AS depth
    ORDER BY depth
  )
END
FROM (
  SELECT known.separator, string_to_array(target_anchor, known.separator) AS parts
  FROM (
    SELECT CASE target_jurisdiction WHEN 'CZE' THEN '-' WHEN 'EU' THEN '-' END AS separator
  ) known
) split
$$;--> statement-breakpoint

-- A citation of a subdivision is a citation of every provision it sits
-- under, so a decision joins each of their buckets once.
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
          AND membership."anchor" = ANY (case_law_provision_anchor_lineage(OLD."jurisdiction", OLD."anchor"))
          AND NOT EXISTS (
            SELECT 1 FROM "case_law_provision_citations" citation
            WHERE citation."decision_id" = OLD."decision_id"
              AND citation."jurisdiction" = OLD."jurisdiction"
              AND citation."work_eli" = OLD."work_eli"
              AND membership."anchor" = ANY (case_law_provision_anchor_lineage(citation."jurisdiction", citation."anchor"))
          )
        )
      );
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW."work_eli" IS NOT NULL THEN
    SELECT decision."source_id", decision."country",
      case_law_statute_citation_is_published(decision."metadata", decision."redacted_at")
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

    INSERT INTO "case_law_statute_citation_memberships" (
      "decision_id", "source_id", "jurisdiction", "work_eli", "target_type", "anchor"
    )
    SELECT NEW."decision_id", citation_source_id, NEW."jurisdiction", NEW."work_eli", 'provision', lineage.anchor
    FROM unnest(case_law_provision_anchor_lineage(NEW."jurisdiction", NEW."anchor")) AS lineage(anchor)
    ORDER BY lineage.anchor
    ON CONFLICT DO NOTHING;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "refresh_case_law_statute_citation_memberships"(target_decision_id uuid)
RETURNS void LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  target_source_id uuid;
  target_country text;
  target_published boolean;
BEGIN
  SELECT source_id, country, case_law_statute_citation_is_published(metadata, redacted_at)
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
        AND (
          membership.target_type = 'work'
          OR membership.anchor = ANY (case_law_provision_anchor_lineage(citation.jurisdiction, citation.anchor))
        )
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
  SELECT citation.decision_id, target_source_id, citation.jurisdiction, citation.work_eli, 'provision', lineage.anchor
  FROM case_law_provision_citations citation
  CROSS JOIN LATERAL unnest(case_law_provision_anchor_lineage(citation.jurisdiction, citation.anchor)) AS lineage(anchor)
  WHERE citation.decision_id = target_decision_id AND citation.jurisdiction = target_country
    AND citation.work_eli IS NOT NULL
  ORDER BY jurisdiction, work_eli, target_type, anchor
  ON CONFLICT DO NOTHING;
END;
$$;--> statement-breakpoint

-- Section buckets gain the decisions that cite only a subdivision. Counts stay
-- hidden until the checkpointed maintenance repair rebuilds every decision.
UPDATE case_law_statute_citation_count_state
SET status = 'building', cursor_decision_id = NULL, updated_at = DEFAULT
WHERE key = 'global';
