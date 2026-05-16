-- Bootstrap `stella_ingestion`, the NOLOGIN role used by the case-law
-- ingestion daemon to mutate the global corpus.
--
-- The 2026-05-10 RLS bootstrap left case_law_* tables read-only for
-- the customer-scoped `stella` role so tenant code paths cannot
-- mutate global reference data. Ingestion is an admin operation and
-- needs write access — but going through the master connection
-- would also grant writes on every tenant table (RLS bypassed,
-- every grant inherited), so we add a third role narrowly scoped
-- to the case-law corpus.

CREATE ROLE stella_ingestion NOLOGIN;

-- Schema access; mirrors the stella bootstrap.
GRANT USAGE ON SCHEMA public TO stella_ingestion;

-- SELECT on the nine case_law_* tables. Reads are needed for
-- upsert logic, source cursors, and dedup checks. Deliberately
-- nothing else — `permission denied for table foo` is the loud
-- failure mode we want if a future ingestion change accidentally
-- touches anything outside the corpus.
GRANT SELECT ON TABLE
  "case_law_sources",
  "case_law_decisions",
  "case_law_citations",
  "case_law_polarity_rules",
  "case_law_court_weights",
  "case_law_fts_configs",
  "case_law_search_documents",
  "case_law_ingestion_events",
  "case_law_ingestion_failures"
TO stella_ingestion;

-- INSERT/UPDATE/DELETE on the eight mutable tables. case_law_sources
-- is config-only — rows seeded by ensureSource at startup, columns
-- otherwise rotated only by migrations.
GRANT INSERT, UPDATE, DELETE ON TABLE
  "case_law_decisions",
  "case_law_citations",
  "case_law_polarity_rules",
  "case_law_court_weights",
  "case_law_fts_configs",
  "case_law_search_documents",
  "case_law_ingestion_events",
  "case_law_ingestion_failures"
TO stella_ingestion;

-- Narrow exception on case_law_sources: each adapter cycle bumps
-- sync_cursor + last_sync_at after a successful pass, and Drizzle's
-- $onUpdate also writes updated_at. Without these three column-level
-- UPDATEs the cursor never advances and every cycle is recorded as
-- failed. All other source columns (name, adapter_key, enabled,
-- config) remain migration-managed.
GRANT UPDATE (sync_cursor, last_sync_at, updated_at)
  ON TABLE "case_law_sources"
  TO stella_ingestion;

-- Sequence usage for serial PKs on the case_law_* tables.
DO $$
DECLARE
  target_sequence regclass;
BEGIN
  FOR target_sequence IN
    SELECT DISTINCT seq.oid::regclass
    FROM pg_class seq
    JOIN pg_namespace n ON n.oid = seq.relnamespace
    JOIN pg_depend dep ON dep.objid = seq.oid
    JOIN pg_class tbl ON tbl.oid = dep.refobjid
    JOIN pg_namespace tbl_ns ON tbl_ns.oid = tbl.relnamespace
    WHERE n.nspname = 'public'
      AND tbl_ns.nspname = 'public'
      AND seq.relkind = 'S'
      AND dep.deptype IN ('a', 'i')
      AND tbl.relname IN (
        'case_law_sources',
        'case_law_decisions',
        'case_law_citations',
        'case_law_polarity_rules',
        'case_law_court_weights',
        'case_law_fts_configs',
        'case_law_search_documents',
        'case_law_ingestion_events',
        'case_law_ingestion_failures'
      )
  LOOP
    EXECUTE format(
      'GRANT USAGE, SELECT ON SEQUENCE %s TO stella_ingestion',
      target_sequence
    );
  END LOOP;
END $$;

-- RLS is enabled on case_law_* with a SELECT-only `case_law_global_access`
-- policy targeting `stella`. stella_ingestion is a separate role, so it
-- needs its own policies. PERMISSIVE FOR ALL with USING (true) /
-- WITH CHECK (true): the corpus has no tenant — there is nothing to
-- scope against. Restriction comes from the table-level GRANT list
-- above, not from RLS.
CREATE POLICY "case_law_ingestion_access" ON "case_law_sources"
  AS PERMISSIVE FOR ALL TO "stella_ingestion"
  USING (true) WITH CHECK (true);
CREATE POLICY "case_law_ingestion_access" ON "case_law_decisions"
  AS PERMISSIVE FOR ALL TO "stella_ingestion"
  USING (true) WITH CHECK (true);
CREATE POLICY "case_law_ingestion_access" ON "case_law_citations"
  AS PERMISSIVE FOR ALL TO "stella_ingestion"
  USING (true) WITH CHECK (true);
CREATE POLICY "case_law_ingestion_access" ON "case_law_polarity_rules"
  AS PERMISSIVE FOR ALL TO "stella_ingestion"
  USING (true) WITH CHECK (true);
CREATE POLICY "case_law_ingestion_access" ON "case_law_court_weights"
  AS PERMISSIVE FOR ALL TO "stella_ingestion"
  USING (true) WITH CHECK (true);
CREATE POLICY "case_law_ingestion_access" ON "case_law_fts_configs"
  AS PERMISSIVE FOR ALL TO "stella_ingestion"
  USING (true) WITH CHECK (true);
CREATE POLICY "case_law_ingestion_access" ON "case_law_search_documents"
  AS PERMISSIVE FOR ALL TO "stella_ingestion"
  USING (true) WITH CHECK (true);
CREATE POLICY "case_law_ingestion_access" ON "case_law_ingestion_events"
  AS PERMISSIVE FOR ALL TO "stella_ingestion"
  USING (true) WITH CHECK (true);
CREATE POLICY "case_law_ingestion_access" ON "case_law_ingestion_failures"
  AS PERMISSIVE FOR ALL TO "stella_ingestion"
  USING (true) WITH CHECK (true);

-- Grant the migration connection role membership in stella_ingestion
-- so it can SET LOCAL ROLE stella_ingestion per transaction.
-- Mirrors the stella bootstrap at the bottom of
-- 20260510140000_document_rls_role_bootstrap.
DO $$
BEGIN
  IF CURRENT_USER <> 'stella_ingestion'
     AND NOT pg_has_role(CURRENT_USER, 'stella_ingestion', 'member') THEN
    EXECUTE format('GRANT stella_ingestion TO %I', CURRENT_USER);
  END IF;
END $$;
