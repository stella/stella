SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The decision-date floor becomes per jurisdiction: USA admits dates from
-- 1600-01-01, and every other country, declared or not, keeps 1800-01-01.
-- The ceiling is unchanged. The new expression accepts every row the old one
-- accepted, so no stored row changes and none is owed a repair.
--
-- Only the constraint swap lives here. It is re-added NOT VALID, which is
-- enforced on every later INSERT or UPDATE while existing rows are left alone,
-- and the migrate entrypoint's online phase
-- (apps/api/src/db/decision-date-ceiling-repair.ts) validates it, as it did
-- the ceiling swap: its repair walk selects nothing under a wider bound, then
-- VALIDATE CONSTRAINT scans under SHARE UPDATE EXCLUSIVE, which does not block
-- reads or writes. The expression below is the rendering of
-- `decisionDateWithinBoundsSql` (apps/api/src/lib/decision-date-bounds-sql.ts),
-- which `decision-date-bounds-sql.db.test.ts` compares against this file.
--
-- Both ALTERs are metadata-only but take ACCESS EXCLUSIVE on a table the
-- ingestion and projection workers write to without pause, in transactions
-- that outlast a short lock wait. A queued ACCESS EXCLUSIVE request stalls
-- every new reader and writer behind it, so the block asks for short waits
-- first and lengthens them only once short ones have failed: a wait wins as
-- soon as the transactions in flight when it queued have ended. Every fifth
-- failure logs who holds the table, for the server log. lock_not_available is
-- what lock_timeout raises. The statement budget is lifted for the block
-- alone: it is the sum of many bounded waits, not one long statement.
--
-- Re-runnable as a pair: a second run drops the validated constraint, adds it
-- NOT VALID again, and the online phase validates it again.
SET statement_timeout = '10min';--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - the same constraint is re-added NOT VALID in the same block with a floor that only widens; the drop exists only so the expression can change, and no row is written between the two
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
        DROP CONSTRAINT IF EXISTS "case_law_decisions_decision_date_bounds";
      ALTER TABLE "case_law_decisions"
        ADD CONSTRAINT "case_law_decisions_decision_date_bounds"
        CHECK (
          "decision_date" IS NULL OR (
            "decision_date" >= make_date(1600, 1, 1)
            AND ("decision_date" >= make_date(1800, 1, 1) OR "country" IN ('USA'))
            AND "decision_date" < ((now() AT TIME ZONE 'UTC')::date
                   + 2)
          )
        ) NOT VALID;
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
          RAISE WARNING 'decision-date floor: attempt % could not lock case_law_decisions; holders: %',
            attempts, coalesce(holders, 'none');
        END IF;
        PERFORM pg_sleep(1 + random() * 2);
    END;
  END LOOP;
END
$$;--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';
