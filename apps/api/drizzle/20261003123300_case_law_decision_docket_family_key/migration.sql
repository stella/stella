SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- `docket_family_key` is the case file a stored docket belongs to, keyed as
-- the docket grammar keys it with any sheet or part the publisher printed
-- after it cut away, so every decision of one file shares it however its own
-- docket is spelled. Null where the docket does not parse, where the
-- jurisdiction has no docket grammar, and on rows no write has keyed yet.
--
-- Nullable with no default, so adding it is metadata-only and no row is
-- rewritten. The ALTER still takes ACCESS EXCLUSIVE on a table the ingestion
-- and projection workers write to without pause, so it runs in the same tiered
-- retry as 20261003121000_case_law_decision_case_number_type: short lock waits
-- first, longer ones once short ones have failed, and every fifth failure logs
-- who holds the table. Re-runnable: guarded by IF NOT EXISTS. Its index is
-- built in the online phase (`ONLINE_MIGRATION_INDEXES`).
SET statement_timeout = '10min';--> statement-breakpoint
DO $$
DECLARE
  attempts integer := 0;
  holders text;
BEGIN
  LOOP
    attempts := attempts + 1;
    PERFORM set_config(
      'lock_timeout',
      CASE
        WHEN attempts <= 20 THEN '2s'
        WHEN attempts <= 30 THEN '10s'
        ELSE '30s'
      END,
      true
    );
    BEGIN
      ALTER TABLE "case_law_decisions"
        ADD COLUMN IF NOT EXISTS "docket_family_key" text;
      EXIT;
    EXCEPTION
      WHEN lock_not_available THEN
        IF attempts >= 36 THEN
          RAISE;
        END IF;
        IF attempts % 5 = 0 THEN
          SELECT string_agg(
                   format('%s %s %s', a.pid, coalesce(a.application_name, '?'),
                          date_trunc('second', now() - a.xact_start)),
                   '; ')
            INTO holders
            FROM pg_catalog.pg_locks l
            JOIN pg_catalog.pg_stat_activity a ON a.pid = l.pid
           WHERE l.relation = 'case_law_decisions'::regclass
             AND l.granted
             AND a.pid <> pg_backend_pid();
          RAISE WARNING 'docket family key: attempt % could not lock case_law_decisions; holders: %',
            attempts, coalesce(holders, 'none');
        END IF;
        PERFORM pg_sleep(1 + random() * 2);
    END;
  END LOOP;
END
$$;--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The public reader reads a docket's case file by this key.
GRANT SELECT (docket_family_key)
  ON TABLE "case_law_decisions"
  TO stella_public_law_reader;
