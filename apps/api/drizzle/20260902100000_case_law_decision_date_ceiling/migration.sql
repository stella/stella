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
-- Re-runnable as a pair: a second run drops the validated constraint, adds it
-- NOT VALID again, and the online phase validates it again.
-- stella-migration-safety: reviewed drop-constraint - the same constraint is re-added NOT VALID by the next statement with a stricter ceiling; the drop exists only so the expression can change, and no row is written between the two
ALTER TABLE "case_law_decisions"
  DROP CONSTRAINT IF EXISTS "case_law_decisions_decision_date_bounds";--> statement-breakpoint
ALTER TABLE "case_law_decisions"
  ADD CONSTRAINT "case_law_decisions_decision_date_bounds"
  CHECK (
    "decision_date" IS NULL OR (
      "decision_date" >= make_date(1800, 1, 1)
      AND "decision_date" < ((now() AT TIME ZONE 'UTC')::date
             + 2)
    )
  ) NOT VALID;
