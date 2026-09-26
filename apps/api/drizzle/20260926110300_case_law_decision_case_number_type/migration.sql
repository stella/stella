SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- `case_number` holds a decision's primary citable reference, and this column
-- says what kind it is: a docket, or a reporter or neutral citation. Every
-- stored row is a docket, which is the default, so none is owed a repair.
--
-- Adding a column with a constant default is metadata-only, and the CHECK is
-- added NOT VALID with no VALIDATE to follow: every stored row holds the
-- default, which the CHECK admits, so there is nothing to scan. The constraint
-- applies to every later INSERT and UPDATE.
--
-- Both ALTERs still take ACCESS EXCLUSIVE on a table the ingestion and
-- projection workers write to without pause, so they run in the same tiered
-- retry as the decision-date floor swap
-- (20260926100200_case_law_decision_date_floor_by_jurisdiction): short lock
-- waits first, longer ones once short ones have failed, and every fifth
-- failure logs who holds the table. Re-runnable: both statements are
-- guarded by IF NOT EXISTS.
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
        ADD COLUMN IF NOT EXISTS "case_number_type" varchar(32)
        DEFAULT 'case-number' NOT NULL;
      IF NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_constraint
         WHERE conrelid = 'case_law_decisions'::regclass
           AND conname = 'case_law_decisions_case_number_type_values'
      ) THEN
        ALTER TABLE "case_law_decisions"
          ADD CONSTRAINT "case_law_decisions_case_number_type_values"
          CHECK ("case_number_type" IN ('case-number', 'neutral-citation', 'reporter-citation')) NOT VALID;
      END IF;
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
          RAISE WARNING 'case number type: attempt % could not lock case_law_decisions; holders: %',
            attempts, coalesce(holders, 'none');
        END IF;
        PERFORM pg_sleep(1 + random() * 2);
    END;
  END LOOP;
END
$$;--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The public reader reads the type wherever it reads `case_number`.
GRANT SELECT (case_number_type)
  ON TABLE "case_law_decisions"
  TO stella_public_law_reader;
