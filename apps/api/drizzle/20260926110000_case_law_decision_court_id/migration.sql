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
-- NOT VALID, which skips the scan of other countries' rows but not the
-- enforcement on a later UPDATE of an old one, so no USA row may be left
-- without an id: the block refuses to continue while any USA row lacks one.
-- On a database that holds such a row the migration fails before it changes
-- anything, and names how many. The operator's repair
-- (src/scripts/repair-legacy-usa-court-ids.ts) runs first: it adds this same
-- column, which the IF NOT EXISTS below then keeps, and gives an id to each
-- USA row whose court is a trusted identity, never to any other.
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
  unresolved bigint;
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
      -- Checked under the lock the column took, so no writer adds a row in
      -- between: the CHECK below is enforced on every later UPDATE, so a USA
      -- row without an id would become unwritable. Refuse the migration
      -- instead; the repair script gives trusted rows their id beforehand.
      SELECT count(*) INTO unresolved
        FROM "case_law_decisions"
       WHERE "country" = 'USA'
         AND "court_id" IS NULL;
      IF unresolved > 0 THEN
        RAISE EXCEPTION 'case_law_decisions holds % USA rows without a court id; run src/scripts/repair-legacy-usa-court-ids.ts --apply and resolve what it reports from source before applying this migration', unresolved
          USING ERRCODE = 'check_violation';
      END IF;
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
