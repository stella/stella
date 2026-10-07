-- requires: 20261005120100_validate_desktop_handoff_failure
-- Exact projections are built online, one decision at a time. No corpus backfill here.
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE case_law_decision_citation_stats (
  decision_id uuid NOT NULL CONSTRAINT decision_citation_stats_decision_fk REFERENCES case_law_decisions(id) ON DELETE CASCADE,
  direction text NOT NULL,
  related_year integer NOT NULL,
  related_country varchar(3),
  related_source_id uuid,
  polarity varchar(16) NOT NULL,
  count bigint NOT NULL,
  CONSTRAINT case_law_decision_citation_stats_bucket_key UNIQUE NULLS NOT DISTINCT
    (decision_id, direction, related_year, related_country, related_source_id, polarity),
  CONSTRAINT case_law_decision_citation_stats_direction CHECK (direction IN ('incoming', 'outgoing')),
  CONSTRAINT case_law_decision_citation_stats_nonnegative CHECK (count >= 0),
  CONSTRAINT case_law_decision_citation_stats_target_shape CHECK (
    (related_source_id IS NULL AND related_country IS NULL AND direction = 'outgoing' AND related_year = 0)
    OR (related_source_id IS NOT NULL AND related_country IS NOT NULL AND (direction = 'incoming' OR related_year = 0))
  ),
  CONSTRAINT case_law_decision_citation_stats_polarity CHECK
    (polarity IN ('positive', 'negative', 'neutral', 'supportive', 'mixed', 'unknown'))
);--> statement-breakpoint

CREATE TABLE case_law_decision_citation_stats_state (
  decision_id uuid PRIMARY KEY CONSTRAINT decision_citation_stats_state_decision_fk REFERENCES case_law_decisions(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  CONSTRAINT case_law_decision_citation_stats_state_status CHECK (status IN ('pending', 'exact'))
);--> statement-breakpoint

-- Source policy and public-country selection remain live read predicates.
-- Year zero represents an unknown date; a NULL source is an unresolved outgoing edge.
CREATE FUNCTION decision_citation_stats_contributions(
  citation case_law_citations, citing case_law_decisions, cited case_law_decisions
) RETURNS TABLE (
  decision_id uuid, direction text, related_year integer,
  related_country varchar(3), related_source_id uuid, polarity varchar(16)
) LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT citation.cited_decision_id, 'incoming',
    coalesce(extract(year FROM citing.decision_date)::integer, 0),
    citing.country, citing.source_id, coalesce(citation.polarity, 'unknown')
  WHERE citation.kind = 'precedent' AND citation.cited_decision_id IS NOT NULL
    AND citing.id IS NOT NULL
    AND jsonb_extract_path_text(citing.metadata, '_stellaPartialObservation', 'isListingOnly') IS DISTINCT FROM 'true'
  UNION ALL
  SELECT citation.citing_decision_id, 'outgoing', 0,
    cited.country, cited.source_id,
    coalesce(citation.polarity, 'unknown')
  WHERE citation.kind = 'precedent' AND citing.id IS NOT NULL
    AND (citation.cited_decision_id IS NULL OR (
      cited.id IS NOT NULL
      AND jsonb_extract_path_text(cited.metadata, '_stellaPartialObservation', 'isListingOnly') IS DISTINCT FROM 'true'
    ))
$$;--> statement-breakpoint

CREATE FUNCTION apply_decision_citation_stats(
  citation case_law_citations, citing case_law_decisions, cited case_law_decisions, delta integer
) RETURNS void LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE contribution record;
BEGIN
  FOR contribution IN
    SELECT c.* FROM decision_citation_stats_contributions(citation, citing, cited) c
    JOIN case_law_decision_citation_stats_state s USING (decision_id)
    WHERE s.status = 'exact'
    ORDER BY c.decision_id, c.direction, c.related_year, c.related_country, c.related_source_id, c.polarity
  LOOP
    IF delta = 1 THEN
      INSERT INTO case_law_decision_citation_stats VALUES (
        contribution.decision_id, contribution.direction, contribution.related_year,
        contribution.related_country, contribution.related_source_id, contribution.polarity, 1
      ) ON CONFLICT ON CONSTRAINT case_law_decision_citation_stats_bucket_key
      DO UPDATE SET count = case_law_decision_citation_stats.count + 1;
    ELSE
      UPDATE case_law_decision_citation_stats SET count = count - 1
      WHERE decision_id = contribution.decision_id AND direction = contribution.direction
        AND related_year = contribution.related_year AND related_country IS NOT DISTINCT FROM contribution.related_country
        AND related_source_id IS NOT DISTINCT FROM contribution.related_source_id AND polarity = contribution.polarity;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'decision citation projection missing for %', contribution.decision_id;
      END IF;
      DELETE FROM case_law_decision_citation_stats
      WHERE decision_id = contribution.decision_id AND direction = contribution.direction
        AND related_year = contribution.related_year AND related_country IS NOT DISTINCT FROM contribution.related_country
        AND related_source_id IS NOT DISTINCT FROM contribution.related_source_id AND polarity = contribution.polarity AND count = 0;
    END IF;
  END LOOP;
END;
$$;--> statement-breakpoint

-- Lock far decisions before reading visibility. NO KEY UPDATE conflicts with
-- visibility changes but remains compatible with foreign-key KEY SHARE locks.
-- Anchor stripes serialize far-decision transitions with online recounts.
-- At most 128 advisory locks are held, even for an unbounded fan-in; hash
-- collisions only serialize otherwise independent decisions.
CREATE FUNCTION sync_decision_citation_stats_edge() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE anchor uuid; lock_key integer; citing case_law_decisions; cited case_law_decisions;
BEGIN
  FOR anchor IN
    SELECT DISTINCT id FROM unnest(ARRAY[
      CASE WHEN TG_OP <> 'INSERT' THEN OLD.citing_decision_id END,
      CASE WHEN TG_OP <> 'INSERT' THEN OLD.cited_decision_id END,
      CASE WHEN TG_OP <> 'DELETE' THEN NEW.citing_decision_id END,
      CASE WHEN TG_OP <> 'DELETE' THEN NEW.cited_decision_id END
    ]) id WHERE id IS NOT NULL ORDER BY id
  LOOP
    PERFORM 1 FROM case_law_decisions WHERE id = anchor FOR NO KEY UPDATE;
  END LOOP;
  FOR lock_key IN
    SELECT DISTINCT (hashtextextended('decision-citation-stats:' || id::text, 0) & 127)::integer AS key
    FROM unnest(ARRAY[
      CASE WHEN TG_OP <> 'INSERT' THEN OLD.citing_decision_id END,
      CASE WHEN TG_OP <> 'INSERT' THEN OLD.cited_decision_id END,
      CASE WHEN TG_OP <> 'DELETE' THEN NEW.citing_decision_id END,
      CASE WHEN TG_OP <> 'DELETE' THEN NEW.cited_decision_id END
    ]) id WHERE id IS NOT NULL ORDER BY key
  LOOP
    PERFORM pg_advisory_xact_lock(19053, lock_key);
  END LOOP;
  IF TG_OP <> 'INSERT' THEN
    SELECT * INTO citing FROM case_law_decisions WHERE id = OLD.citing_decision_id;
    SELECT * INTO cited FROM case_law_decisions WHERE id = OLD.cited_decision_id;
    PERFORM apply_decision_citation_stats(OLD, citing, cited, -1);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT * INTO citing FROM case_law_decisions WHERE id = NEW.citing_decision_id;
    SELECT * INTO cited FROM case_law_decisions WHERE id = NEW.cited_decision_id;
    PERFORM apply_decision_citation_stats(NEW, citing, cited, 1);
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint

CREATE FUNCTION sync_decision_citation_stats_decision() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE citation case_law_citations; citing case_law_decisions; cited case_law_decisions; lock_key integer;
BEGIN
  -- The decision mutation already holds its row lock. No new edge touching
  -- it can pass the edge trigger while its contribution buckets are moved.
  FOR lock_key IN
    SELECT DISTINCT (hashtextextended('decision-citation-stats:' || id::text, 0) & 127)::integer AS key
    FROM (
      SELECT OLD.id AS id
      UNION SELECT citing_decision_id FROM case_law_citations WHERE cited_decision_id = OLD.id
      UNION SELECT cited_decision_id FROM case_law_citations WHERE citing_decision_id = OLD.id AND cited_decision_id IS NOT NULL
    ) anchors ORDER BY key
  LOOP
    PERFORM pg_advisory_xact_lock(19053, lock_key);
  END LOOP;
  IF TG_OP = 'DELETE' THEN
    -- Perform FK effects while OLD still exists, so both directions can
    -- subtract the old contribution before CASCADE / SET NULL lose it.
    DELETE FROM case_law_citations WHERE citing_decision_id = OLD.id;
    UPDATE case_law_citations SET cited_decision_id = NULL WHERE cited_decision_id = OLD.id;
    RETURN OLD;
  END IF;
  FOR citation IN
    SELECT * FROM case_law_citations
    WHERE citing_decision_id = OLD.id OR cited_decision_id = OLD.id ORDER BY id
  LOOP
    SELECT * INTO citing FROM case_law_decisions WHERE id = citation.citing_decision_id;
    SELECT * INTO cited FROM case_law_decisions WHERE id = citation.cited_decision_id;
    PERFORM apply_decision_citation_stats(citation, citing, cited, -1);
    IF citing.id = OLD.id THEN citing := NEW; END IF;
    IF cited.id = OLD.id THEN cited := NEW; END IF;
    PERFORM apply_decision_citation_stats(citation, citing, cited, 1);
  END LOOP;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE FUNCTION recount_decision_citation_stats(target uuid)
RETURNS TABLE (
  decision_id uuid, direction text, related_year integer,
  related_country varchar(3), related_source_id uuid, polarity varchar(16), count bigint
) LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT contribution.*, count(*)::bigint
  FROM case_law_citations citation
  JOIN case_law_decisions citing ON citing.id = citation.citing_decision_id
  LEFT JOIN case_law_decisions cited ON cited.id = citation.cited_decision_id
  CROSS JOIN LATERAL decision_citation_stats_contributions(citation, citing, cited) contribution
  WHERE (citation.citing_decision_id = target OR citation.cited_decision_id = target)
    AND contribution.decision_id = target
  GROUP BY contribution.decision_id, contribution.direction, contribution.related_year,
    contribution.related_country, contribution.related_source_id, contribution.polarity
$$;--> statement-breakpoint

CREATE FUNCTION lock_decision_citation_stats(target uuid) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM case_law_decisions WHERE id = target FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'decision citation stats target does not exist: %', target;
  END IF;
  PERFORM pg_advisory_xact_lock(19053, (hashtextextended('decision-citation-stats:' || target::text, 0) & 127)::integer);
END;
$$;--> statement-breakpoint

CREATE FUNCTION refresh_decision_citation_stats(target uuid) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM lock_decision_citation_stats(target);
  DELETE FROM case_law_decision_citation_stats WHERE decision_id = target;
  INSERT INTO case_law_decision_citation_stats SELECT * FROM recount_decision_citation_stats(target);
  INSERT INTO case_law_decision_citation_stats_state (decision_id, status) VALUES (target, 'exact')
  ON CONFLICT ON CONSTRAINT case_law_decision_citation_stats_state_pkey DO UPDATE SET status = 'exact';
END;
$$;--> statement-breakpoint

-- Conflict handling may discard the proposed row; count only successful inserts.
CREATE TRIGGER case_law_citation_stats_edge_insert AFTER INSERT ON case_law_citations
FOR EACH ROW EXECUTE FUNCTION sync_decision_citation_stats_edge();--> statement-breakpoint
CREATE TRIGGER case_law_citation_stats_edge_delete BEFORE DELETE ON case_law_citations
FOR EACH ROW EXECUTE FUNCTION sync_decision_citation_stats_edge();--> statement-breakpoint
CREATE TRIGGER case_law_citation_stats_edge_update
BEFORE UPDATE OF citing_decision_id, cited_decision_id, kind, polarity ON case_law_citations
FOR EACH ROW
WHEN (ROW(OLD.citing_decision_id, OLD.cited_decision_id, OLD.kind, OLD.polarity)
  IS DISTINCT FROM ROW(NEW.citing_decision_id, NEW.cited_decision_id, NEW.kind, NEW.polarity))
EXECUTE FUNCTION sync_decision_citation_stats_edge();--> statement-breakpoint
CREATE TRIGGER case_law_citation_stats_decision_update
BEFORE UPDATE OF source_id, metadata, country, decision_date ON case_law_decisions
FOR EACH ROW
WHEN (ROW(OLD.source_id, OLD.country, extract(year FROM OLD.decision_date),
  jsonb_extract_path_text(OLD.metadata, '_stellaPartialObservation', 'isListingOnly') IS DISTINCT FROM 'true')
IS DISTINCT FROM ROW(NEW.source_id, NEW.country, extract(year FROM NEW.decision_date),
  jsonb_extract_path_text(NEW.metadata, '_stellaPartialObservation', 'isListingOnly') IS DISTINCT FROM 'true'))
EXECUTE FUNCTION sync_decision_citation_stats_decision();--> statement-breakpoint
CREATE TRIGGER case_law_citation_stats_decision_delete BEFORE DELETE ON case_law_decisions
FOR EACH ROW EXECUTE FUNCTION sync_decision_citation_stats_decision();--> statement-breakpoint

ALTER TABLE case_law_decision_citation_stats ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE case_law_decision_citation_stats FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY case_law_global_access ON case_law_decision_citation_stats
FOR SELECT TO stella USING (true);--> statement-breakpoint
CREATE POLICY case_law_ingestion_access ON case_law_decision_citation_stats
FOR ALL TO stella_ingestion USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT ON case_law_decision_citation_stats TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON case_law_decision_citation_stats TO stella_ingestion;--> statement-breakpoint

ALTER TABLE case_law_decision_citation_stats_state ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE case_law_decision_citation_stats_state FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY case_law_global_access ON case_law_decision_citation_stats_state
FOR SELECT TO stella USING (true);--> statement-breakpoint
CREATE POLICY case_law_ingestion_access ON case_law_decision_citation_stats_state
FOR ALL TO stella_ingestion USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT ON case_law_decision_citation_stats_state TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON case_law_decision_citation_stats_state TO stella_ingestion;--> statement-breakpoint

CREATE POLICY public_law_reader_access ON case_law_decision_citation_stats
FOR SELECT TO stella_public_law_reader USING (
  CASE WHEN related_source_id IS NULL THEN true ELSE EXISTS (
    SELECT 1 FROM case_law_sources source WHERE source.id = related_source_id
    AND (source.descriptor IS NULL OR source.descriptor ->> 'allowsRedistribution' = 'true')
  ) END
);--> statement-breakpoint
CREATE POLICY public_law_reader_access ON case_law_decision_citation_stats_state
FOR SELECT TO stella_public_law_reader USING (true);--> statement-breakpoint

-- Reader column grants follow after this release accepts them as permitted.
REVOKE ALL ON FUNCTION decision_citation_stats_contributions(case_law_citations, case_law_decisions, case_law_decisions) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION decision_citation_stats_contributions(case_law_citations, case_law_decisions, case_law_decisions) TO stella_ingestion;--> statement-breakpoint
REVOKE ALL ON FUNCTION apply_decision_citation_stats(case_law_citations, case_law_decisions, case_law_decisions, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION apply_decision_citation_stats(case_law_citations, case_law_decisions, case_law_decisions, integer) TO stella_ingestion;--> statement-breakpoint
REVOKE ALL ON FUNCTION sync_decision_citation_stats_edge() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION sync_decision_citation_stats_edge() TO stella_ingestion;--> statement-breakpoint
REVOKE ALL ON FUNCTION sync_decision_citation_stats_decision() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION sync_decision_citation_stats_decision() TO stella_ingestion;--> statement-breakpoint
REVOKE ALL ON FUNCTION recount_decision_citation_stats(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION recount_decision_citation_stats(uuid) TO stella_ingestion;--> statement-breakpoint
REVOKE ALL ON FUNCTION refresh_decision_citation_stats(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION refresh_decision_citation_stats(uuid) TO stella_ingestion;--> statement-breakpoint
REVOKE ALL ON FUNCTION lock_decision_citation_stats(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION lock_decision_citation_stats(uuid) TO stella_ingestion;--> statement-breakpoint
