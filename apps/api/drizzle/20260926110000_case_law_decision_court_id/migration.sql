SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A decision's court id, for a jurisdiction that identifies courts by a court
-- directory's id rather than by name. Nullable: every other jurisdiction
-- stores none, and its rows are untouched.
--
-- The CHECK holds a row to carrying an id exactly when its country is a
-- directory jurisdiction; it is the rendering of `decisionCourtIdByCountrySql`
-- (apps/api/src/lib/case-law/decision-court-id-sql.ts), which
-- `decision-court-identity.db.test.ts` compares against this file. It is added
-- NOT VALID: enforced on every later INSERT or UPDATE, so a directory
-- jurisdiction's row cannot be written or changed without its id, while a row
-- stored before the id existed is left alone until it is resolved from its
-- source and the constraint is validated.
--
-- Both ALTERs are metadata-only but take ACCESS EXCLUSIVE on a table the
-- ingestion and projection workers write to without pause, so they run in the
-- same tiered lock retry as 20260926100200_case_law_decision_date_floor_by_
-- jurisdiction: short waits first, longer ones only after short ones failed,
-- and every fifth failure logs who holds the table. The statement budget is
-- lifted for the block alone: it is the sum of many bounded waits.
--
-- Re-runnable: both statements are guarded by IF NOT EXISTS.
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
        ADD COLUMN IF NOT EXISTS "court_id" varchar(64);
      IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_constraint
         WHERE conname = 'case_law_decisions_court_id_by_country'
           AND conrelid = 'case_law_decisions'::regclass
      ) THEN
        ALTER TABLE "case_law_decisions"
          ADD CONSTRAINT "case_law_decisions_court_id_by_country"
          CHECK (("country" IN ('USA')) = ("court_id" IS NOT NULL)) NOT VALID;
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
          RAISE WARNING 'decision court id: attempt % could not lock case_law_decisions; holders: %',
            attempts, coalesce(holders, 'none');
        END IF;
        PERFORM pg_sleep(1 + random() * 2);
    END;
  END LOOP;
END
$$;--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';
