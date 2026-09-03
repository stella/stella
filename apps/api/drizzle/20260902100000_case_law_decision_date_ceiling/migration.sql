SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The decision-date ceiling moves from "the end of next year" to "tomorrow
-- (UTC)": a decision cannot have been issued in the future, and the old
-- ceiling let publisher parsing artifacts dated months ahead sort to the top
-- of every newest-first list. The floor is unchanged.
--
-- Only the constraint swap lives here. An upgraded database still holds rows
-- dated past the new ceiling, and citation edges decided under those dates;
-- both are repaired by the migrate entrypoint's online phase
-- (apps/api/src/db/decision-date-ceiling-repair.ts) in bounded transactions
-- over indexed access paths, and the constraint is validated there once no
-- such row remains. The first form of this file did that repair in place, with
-- one UPDATE over "case_law_citations" that the table cannot serve from an
-- index; it exceeded the statement budget on a corpus-sized table.
--
-- Until validation, NOT VALID means the CHECK is enforced on every later
-- INSERT or UPDATE of a row (a row past the ceiling can only be written back
-- into bounds) while existing rows are left alone. The expression below is
-- the rendering of `decisionDateWithinBoundsSql`
-- (apps/api/src/lib/decision-date-bounds-sql.ts), which
-- `decision-date-bounds-sql.db.test.ts` compares against this file.
--
-- Both ALTERs are metadata-only but take ACCESS EXCLUSIVE on a table the
-- ingestion and projection workers write to without pause, so a single 1s
-- lock wait rarely wins it. The block keeps each wait short (a queued ACCESS
-- EXCLUSIVE request stalls every new reader and writer behind it) and retries
-- with jitter until a gap between writer transactions lets the swap through.
-- lock_not_available is what lock_timeout raises. The statement budget is
-- lifted for the block alone: it is the sum of many short waits, not one long
-- statement.
--
-- Re-runnable as a pair: a second run drops the validated constraint, adds it
-- NOT VALID again, and the online phase validates it again.
SET statement_timeout = '5min';--> statement-breakpoint
SET lock_timeout = '2s';--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - the same constraint is re-added NOT VALID in the same block with a stricter ceiling; the drop exists only so the expression can change, and no row is written between the two
DO $$
DECLARE
  attempts integer := 0;
BEGIN
  LOOP
    BEGIN
      ALTER TABLE "case_law_decisions"
        DROP CONSTRAINT IF EXISTS "case_law_decisions_decision_date_bounds";
      ALTER TABLE "case_law_decisions"
        ADD CONSTRAINT "case_law_decisions_decision_date_bounds"
        CHECK (
          "decision_date" IS NULL OR (
            "decision_date" >= make_date(1800, 1, 1)
            AND "decision_date" < ((now() AT TIME ZONE 'UTC')::date
                   + 2)
          )
        ) NOT VALID;
      EXIT;
    EXCEPTION
      WHEN lock_not_available THEN
        attempts := attempts + 1;
        IF attempts >= 60 THEN
          RAISE;
        END IF;
        PERFORM pg_sleep(1 + random() * 2);
    END;
  END LOOP;
END
$$;--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';
