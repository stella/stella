SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

CREATE TABLE public.case_law_population_counts (
  kind text NOT NULL,
  country varchar(3) NOT NULL,
  source_id uuid NOT NULL,
  value varchar(512) NOT NULL,
  total integer NOT NULL,
  CONSTRAINT case_law_population_counts_pkey PRIMARY KEY (kind, country, source_id, value),
  CONSTRAINT case_law_population_counts_total_positive CHECK (total > 0),
  CONSTRAINT case_law_population_counts_kind_valid CHECK (kind IN ('country', 'court', 'year', 'coverage-year', 'pending-text'))
);--> statement-breakpoint
CREATE TABLE public.case_law_population_deltas (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  kind text NOT NULL,
  country varchar(3) NOT NULL,
  source_id uuid NOT NULL,
  value varchar(512) NOT NULL,
  delta integer NOT NULL,
  CONSTRAINT case_law_population_deltas_nonzero CHECK (delta <> 0),
  CONSTRAINT case_law_population_deltas_kind_valid CHECK (kind IN ('country', 'court', 'year', 'coverage-year', 'pending-text'))
);--> statement-breakpoint
ALTER TABLE public.case_law_population_deltas ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.case_law_population_deltas FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY case_law_population_delta_owner_access ON public.case_law_population_deltas FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_population_deltas'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_population_deltas'::regclass));--> statement-breakpoint
CREATE POLICY public_law_reader_access ON public.case_law_population_deltas FOR SELECT TO stella_public_law_reader
  USING (EXISTS (SELECT 1 FROM public.case_law_sources s WHERE s.id = source_id
    AND (s.descriptor IS NULL OR s.descriptor->>'allowsRedistribution' = 'true')));--> statement-breakpoint
GRANT SELECT (id, kind, country, source_id, value, delta) ON public.case_law_population_deltas TO stella_public_law_reader;--> statement-breakpoint

-- The bound counts the global queue before any policy filtering. A stalled
-- fold refuses the read; it never turns a truncated queue into a false total.
-- stella-migration-safety: reviewed security-definer - read-only bounded backlog assertion with fixed search path; exposes no queue rows or operational checkpoint
CREATE FUNCTION public.assert_case_law_population_backlog_bounded()
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF (SELECT count(*) FROM (SELECT id FROM public.case_law_population_deltas ORDER BY id LIMIT 16385) bounded) > 16384 THEN
    RAISE EXCEPTION 'Case-law population delta backlog exceeds the read limit' USING ERRCODE = '55000';
  END IF;
  RETURN true;
END
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.assert_case_law_population_backlog_bounded() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.assert_case_law_population_backlog_bounded() TO stella_public_law_reader;--> statement-breakpoint

CREATE VIEW public.case_law_population_counts_live WITH (security_invoker = true) AS
WITH pending AS MATERIALIZED (
  SELECT kind, country, source_id, value, delta
  FROM public.case_law_population_deltas ORDER BY id LIMIT 16385
)
SELECT kind, country, source_id, value, sum(total)::integer AS total
FROM (
  SELECT kind, country, source_id, value, total FROM public.case_law_population_counts
  UNION ALL
  SELECT kind, country, source_id, value, delta AS total FROM pending
) population
WHERE (SELECT public.assert_case_law_population_backlog_bounded())
GROUP BY kind, country, source_id, value
HAVING sum(total) <> 0;--> statement-breakpoint
GRANT SELECT (kind, country, source_id, value, total) ON public.case_law_population_counts_live TO stella_public_law_reader;--> statement-breakpoint

CREATE TABLE public.case_law_population_projections (
  decision_id uuid PRIMARY KEY,
  source_id uuid NOT NULL,
  country varchar(3) NOT NULL,
  buckets jsonb NOT NULL,
  court varchar(512) NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  publication text NOT NULL,
  CONSTRAINT case_law_population_projection_publication_valid CHECK (publication IN ('published', 'unpublished'))
);--> statement-breakpoint
CREATE TABLE public.case_law_population_seed_state (
  slot integer PRIMARY KEY CONSTRAINT case_law_population_seed_singleton CHECK (slot = 0),
  cursor uuid,
  source_id uuid,
  phase text NOT NULL DEFAULT 'scan',
  CONSTRAINT case_law_population_seed_phase_valid CHECK (phase IN ('scan', 'fold', 'complete'))
);--> statement-breakpoint
INSERT INTO public.case_law_population_seed_state (slot) VALUES (0);--> statement-breakpoint
ALTER TABLE public.case_law_population_counts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.case_law_population_counts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.case_law_population_projections ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.case_law_population_projections FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.case_law_population_seed_state ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.case_law_population_seed_state FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY case_law_population_count_owner_access ON public.case_law_population_counts FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_population_counts'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_population_counts'::regclass));--> statement-breakpoint
CREATE POLICY case_law_population_projection_owner_access ON public.case_law_population_projections FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_population_projections'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_population_projections'::regclass));--> statement-breakpoint
CREATE POLICY case_law_population_seed_owner_access ON public.case_law_population_seed_state FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_population_seed_state'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.case_law_population_seed_state'::regclass));--> statement-breakpoint
CREATE POLICY public_law_reader_access ON public.case_law_population_counts FOR SELECT TO stella_public_law_reader
  USING (EXISTS (SELECT 1 FROM public.case_law_sources s WHERE s.id = source_id
    AND (s.descriptor IS NULL OR s.descriptor->>'allowsRedistribution' = 'true')));--> statement-breakpoint
GRANT SELECT (kind, country, source_id, value, total) ON public.case_law_population_counts TO stella_public_law_reader;--> statement-breakpoint
CREATE POLICY public_law_reader_access ON public.case_law_population_projections FOR SELECT TO stella_public_law_reader
  USING (publication = 'published' AND EXISTS (SELECT 1 FROM public.case_law_sources s WHERE s.id = source_id
    AND (s.descriptor IS NULL OR s.descriptor->>'allowsRedistribution' = 'true')));--> statement-breakpoint
GRANT SELECT (source_id, country, court, created_at, updated_at, publication) ON public.case_law_population_projections TO stella_public_law_reader;--> statement-breakpoint

-- Publication is shared with the corpus views; coverage years also reject
-- dates before a docket's filing year. The bounded date CHECK is already
-- enforced on writes; the explicit predicate also filters legacy seed rows.
CREATE FUNCTION public.case_law_population_buckets(decision public.case_law_decisions)
RETURNS jsonb LANGUAGE sql STABLE PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'value', value)), '[]'::jsonb)
  FROM (
    SELECT 'country' AS kind, decision.country::text AS value
    WHERE public.case_law_statute_citation_is_published(decision.metadata, decision.redacted_at)
    UNION ALL SELECT 'court', decision.court
    WHERE public.case_law_statute_citation_is_published(decision.metadata, decision.redacted_at)
    UNION ALL SELECT 'year', to_char(decision.decision_date, 'YYYY')
    WHERE public.case_law_statute_citation_is_published(decision.metadata, decision.redacted_at)
      AND decision.decision_date IS NOT NULL
    UNION ALL SELECT 'coverage-year', extract(year FROM decision.decision_date)::integer::text
    WHERE public.case_law_statute_citation_is_published(decision.metadata, decision.redacted_at)
      AND (
  decision.decision_date >= make_date(1600, 1, 1)
  AND (decision.decision_date >= make_date(1800, 1, 1) OR decision.country IN ('GBR', 'USA'))
  AND decision.decision_date < ((now() AT TIME ZONE 'UTC')::date
         + 2)
) AND coalesce(extract(year FROM decision.decision_date) >=
    (public.decision_docket_filing_year(decision.case_number, decision.country)->>'year')::integer, true)
    UNION ALL SELECT 'pending-text', ''
    WHERE decision.redacted_at IS NULL AND decision.fulltext IS NULL
      AND jsonb_extract_path_text(decision.metadata, '_stellaPartialObservation', 'isListingOnly') = 'true'
  ) buckets
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.case_law_population_buckets(public.case_law_decisions) FROM PUBLIC;--> statement-breakpoint

-- Ingestion only appends grouped commutative deltas. It never locks a shared
-- counter row, including across mixed upsert phases or repeated statements.
-- stella-migration-safety: reviewed security-definer - trigger-only function with fixed search path and PUBLIC execute revoked; appends only derived public population deltas
CREATE FUNCTION public.apply_case_law_population_projection()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  delta_sql text;
BEGIN
  delta_sql := CASE TG_OP
    WHEN 'INSERT' THEN 'SELECT source_id, country, buckets, 1 AS delta FROM new_projections'
    WHEN 'DELETE' THEN 'SELECT source_id, country, buckets, -1 AS delta FROM old_projections'
    WHEN 'UPDATE' THEN 'SELECT source_id, country, buckets, 1 AS delta FROM new_projections UNION ALL SELECT source_id, country, buckets, -1 AS delta FROM old_projections'
  END;
  EXECUTE 'INSERT INTO public.case_law_population_deltas (kind, country, source_id, value, delta)
    SELECT b->>''kind'', country, source_id, b->>''value'', sum(delta)::integer
    FROM (' || delta_sql || ') projection_rows CROSS JOIN LATERAL jsonb_array_elements(projection_rows.buckets) b
    GROUP BY b->>''kind'', country, source_id, b->>''value'' HAVING sum(delta) <> 0';
  RETURN NULL;
END
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.apply_case_law_population_projection() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER case_law_population_projection_delta
AFTER INSERT ON public.case_law_population_projections
REFERENCING NEW TABLE AS new_projections
FOR EACH STATEMENT EXECUTE FUNCTION public.apply_case_law_population_projection();--> statement-breakpoint
CREATE TRIGGER case_law_population_projection_update
AFTER UPDATE ON public.case_law_population_projections
REFERENCING NEW TABLE AS new_projections OLD TABLE AS old_projections
FOR EACH STATEMENT EXECUTE FUNCTION public.apply_case_law_population_projection();--> statement-breakpoint
CREATE TRIGGER case_law_population_projection_delete
AFTER DELETE ON public.case_law_population_projections
REFERENCING OLD TABLE AS old_projections
FOR EACH STATEMENT EXECUTE FUNCTION public.apply_case_law_population_projection();--> statement-breakpoint

-- Statement projection preserves bulk writes through the counter boundary.
-- The explicit delete is one set operation; a row-cascading foreign key would
-- split one decision delete statement into a counter update per decision.
-- stella-migration-safety: reviewed security-definer - trigger-only function with fixed search path and PUBLIC execute revoked; only projects transition-table decisions in their transaction
CREATE FUNCTION public.project_case_law_population_decision()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.case_law_population_projections p
    USING old_decisions d WHERE p.decision_id = d.id;
    RETURN NULL;
  END IF;
  INSERT INTO public.case_law_population_projections (decision_id, source_id, country, buckets, court, created_at, updated_at, publication)
  SELECT d.id, d.source_id, d.country, public.case_law_population_buckets(d::public.case_law_decisions), d.court, d.created_at, d.updated_at,
    CASE WHEN public.case_law_statute_citation_is_published(d.metadata, d.redacted_at) THEN 'published' ELSE 'unpublished' END
  FROM new_decisions d
  ORDER BY d.id
  ON CONFLICT ON CONSTRAINT case_law_population_projections_pkey DO UPDATE SET source_id = EXCLUDED.source_id, country = EXCLUDED.country, buckets = EXCLUDED.buckets, court = EXCLUDED.court, created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at, publication = EXCLUDED.publication
  WHERE (case_law_population_projections.source_id, case_law_population_projections.country, case_law_population_projections.buckets, case_law_population_projections.court, case_law_population_projections.created_at, case_law_population_projections.updated_at, case_law_population_projections.publication)
    IS DISTINCT FROM (EXCLUDED.source_id, EXCLUDED.country, EXCLUDED.buckets, EXCLUDED.court, EXCLUDED.created_at, EXCLUDED.updated_at, EXCLUDED.publication);
  RETURN NULL;
END
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.project_case_law_population_decision() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER case_law_population_decision_write
AFTER INSERT ON public.case_law_decisions REFERENCING NEW TABLE AS new_decisions
FOR EACH STATEMENT EXECUTE FUNCTION public.project_case_law_population_decision();--> statement-breakpoint
CREATE TRIGGER case_law_population_decision_update
AFTER UPDATE ON public.case_law_decisions REFERENCING NEW TABLE AS new_decisions
FOR EACH STATEMENT EXECUTE FUNCTION public.project_case_law_population_decision();--> statement-breakpoint
CREATE TRIGGER case_law_population_decision_delete
AFTER DELETE ON public.case_law_decisions REFERENCING OLD TABLE AS old_decisions
FOR EACH STATEMENT EXECUTE FUNCTION public.project_case_law_population_decision();--> statement-breakpoint

-- One fold owner orders every counter key. Selected ids are a batch, never
-- a commit watermark: uncommitted lower identities remain queued for later.
CREATE FUNCTION public.fold_case_law_population_counts(batch_size integer)
RETURNS TABLE(folded integer, done boolean)
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  selected_ids bigint[];
  folded_totals jsonb;
BEGIN
  IF batch_size IS NULL OR batch_size < 1 OR batch_size > 2048 THEN RAISE EXCEPTION 'Invalid population fold batch size'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext('case-law-population-fold')) THEN
    RETURN QUERY SELECT 0, false;
    RETURN;
  END IF;
  SELECT array_agg(id) INTO selected_ids FROM (
    SELECT id FROM public.case_law_population_deltas ORDER BY id LIMIT batch_size
  ) batch;
  IF selected_ids IS NULL THEN
    RETURN QUERY SELECT 0, true;
    RETURN;
  END IF;
  SELECT jsonb_agg(to_jsonb(next_total) ORDER BY kind, country, source_id, value)
  INTO folded_totals
  FROM (
    SELECT changes.kind, changes.country, changes.source_id, changes.value,
      coalesce(counts.total, 0) + changes.delta AS total
    FROM (
      SELECT kind, country, source_id, value, sum(delta)::integer AS delta
      FROM public.case_law_population_deltas WHERE id = ANY(selected_ids)
      GROUP BY kind, country, source_id, value HAVING sum(delta) <> 0
    ) changes
    LEFT JOIN public.case_law_population_counts counts USING (kind, country, source_id, value)
  ) next_total;
  IF folded_totals IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM jsonb_to_recordset(folded_totals)
      AS totals(total integer) WHERE total < 0) THEN
      RAISE EXCEPTION 'Case-law population fold would produce a negative count' USING ERRCODE = '22000';
    END IF;
    INSERT INTO public.case_law_population_counts (kind, country, source_id, value, total)
    SELECT kind, country, source_id, value, total
    FROM jsonb_to_recordset(folded_totals)
      AS totals(kind text, country varchar(3), source_id uuid, value varchar(512), total integer)
    WHERE total > 0 ORDER BY kind, country, source_id, value
    ON CONFLICT ON CONSTRAINT case_law_population_counts_pkey DO UPDATE SET total = EXCLUDED.total;
    DELETE FROM public.case_law_population_counts counts
    USING jsonb_to_recordset(folded_totals)
      AS totals(kind text, country varchar(3), source_id uuid, value varchar(512), total integer)
    WHERE totals.total = 0 AND counts.kind = totals.kind AND counts.country = totals.country
      AND counts.source_id = totals.source_id AND counts.value = totals.value;
  END IF;
  DELETE FROM public.case_law_population_deltas WHERE id = ANY(selected_ids);
  RETURN QUERY SELECT cardinality(selected_ids), NOT EXISTS (SELECT 1 FROM public.case_law_population_deltas);
END
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.fold_case_law_population_counts(integer) FROM PUBLIC;--> statement-breakpoint

-- Lock decisions before projecting them, matching the write trigger's order.
-- Inserts below the cursor are already projected by that same trigger.
CREATE FUNCTION public.seed_case_law_population_counts(batch_size integer)
RETURNS TABLE(cursor uuid, processed integer, done boolean)
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  seed public.case_law_population_seed_state;
  batch_cursor uuid;
  batch_count integer := 0;
  fold_done boolean;
BEGIN
  IF batch_size IS NULL OR batch_size < 1 OR batch_size > 2048 THEN RAISE EXCEPTION 'Invalid population seed batch size'; END IF;
  SELECT * INTO STRICT seed FROM public.case_law_population_seed_state WHERE slot = 0 FOR UPDATE;
  IF seed.phase = 'complete' THEN RETURN QUERY SELECT seed.cursor, 0, true; RETURN; END IF;
  IF seed.phase = 'scan' THEN
    IF seed.source_id IS NULL THEN
      SELECT id INTO seed.source_id FROM public.case_law_sources ORDER BY id LIMIT 1;
      IF seed.source_id IS NULL THEN seed.phase := 'fold'; END IF;
    END IF;
    IF seed.phase = 'scan' THEN
      EXECUTE 'WITH batch AS MATERIALIZED (
        SELECT d.* FROM public.case_law_decisions d WHERE d.source_id = $3 '
        || CASE WHEN seed.cursor IS NULL THEN '' ELSE 'AND d.id > $2 ' END ||
        'ORDER BY d.id LIMIT $1 FOR UPDATE OF d
      ), projected AS (
        INSERT INTO public.case_law_population_projections (decision_id, source_id, country, buckets, court, created_at, updated_at, publication)
        SELECT b.id, b.source_id, b.country, public.case_law_population_buckets(b::public.case_law_decisions), b.court, b.created_at, b.updated_at,
          CASE WHEN public.case_law_statute_citation_is_published(b.metadata, b.redacted_at) THEN ''published'' ELSE ''unpublished'' END FROM batch b
        ON CONFLICT ON CONSTRAINT case_law_population_projections_pkey DO NOTHING
      ) SELECT max(id::text)::uuid, count(*)::integer FROM batch'
      INTO batch_cursor, batch_count USING batch_size, seed.cursor, seed.source_id;
      IF batch_count = 0 THEN
        SELECT id INTO seed.source_id FROM public.case_law_sources WHERE id > seed.source_id ORDER BY id LIMIT 1;
        seed.cursor := NULL;
        IF seed.source_id IS NULL THEN seed.phase := 'fold'; END IF;
      ELSE
        seed.cursor := batch_cursor;
      END IF;
    END IF;
  END IF;
  SELECT result.done INTO STRICT fold_done FROM public.fold_case_law_population_counts(2048) result;
  IF seed.phase = 'fold' AND fold_done THEN seed.phase := 'complete'; END IF;
  UPDATE public.case_law_population_seed_state s
  SET cursor = seed.cursor, source_id = seed.source_id, phase = seed.phase WHERE slot = 0;
  RETURN QUERY SELECT seed.cursor, batch_count, seed.phase = 'complete';
END
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.seed_case_law_population_counts(integer) FROM PUBLIC;
--> statement-breakpoint

-- stella-migration-safety: reviewed security-definer - read-only readiness assertion with fixed search path; exposes no operational checkpoint or corpus data
CREATE FUNCTION public.assert_case_law_population_ready()
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  phase text;
BEGIN
  SELECT seed.phase INTO STRICT phase FROM public.case_law_population_seed_state seed WHERE slot = 0;
  IF phase <> 'complete' THEN
    RAISE EXCEPTION 'Case-law population counts are not seeded' USING ERRCODE = '55000';
  END IF;
  RETURN true;
END
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.assert_case_law_population_ready() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.assert_case_law_population_ready() TO stella_public_law_reader;
