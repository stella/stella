SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The decision-date ceiling moves from "the end of next year" to "tomorrow
-- (UTC)": a decision cannot have been issued in the future, and the old
-- ceiling let publisher parsing artifacts dated months ahead sort to the top
-- of every newest-first list. The floor is unchanged.
--
-- Rows dated past the new ceiling cannot survive the constraint (NOT VALID
-- is enforced on every later UPDATE of such a row, and VALIDATE fails while
-- one remains), so they are cleared first the way 20260818090000 and
-- `repair-decision-dates.ts` clear them: `decision_date` to NULL,
-- `indexed_hash` cleared so the search projection is rebuilt. The script
-- additionally reopens citation edges decided under the old date and is the
-- intended pre-step for an operator; this statement is the floor. Bounded by
-- "case_law_decisions_date_idx": only rows past the ceiling are visited
-- (21 rows in production at authoring time).
--
-- The citation graph is told first. The resolver filters candidates on
-- `decision_date`, so edges decided under the old date, and citations whose
-- key names one of these decisions, are put back to pending for the standing
-- walk, which only revisits unsettled rows. This is the coarse form of what
-- `reopenCitationsFrom` and `reopenCitationsForDecisionKey` do per decision:
-- every non-pending citation touching an affected decision or sharing its
-- key, without the per-jurisdiction reach filter. Reopening more than the
-- script would costs the walk a re-resolution; reopening less would leave a
-- stale edge, which is the fault being repaired. Under the walk's own
-- advisory lock, as the helpers take it.
SELECT pg_advisory_xact_lock(hashtext('case_law'), hashtext('citation_resolution_walk'));--> statement-breakpoint
WITH affected AS (
  SELECT "id", "citation_key"
    FROM "case_law_decisions"
   WHERE "decision_date" >= ((now() AT TIME ZONE 'UTC')::date + 2)
)
UPDATE "case_law_citations" c
   SET "resolution_status" = 'pending',
       "cited_decision_id" = NULL,
       "resolution_rule_id" = NULL
 WHERE c."resolution_status" <> 'pending'
   AND (
        c."citing_decision_id" IN (SELECT "id" FROM affected)
     OR c."cited_decision_id" IN (SELECT "id" FROM affected)
     OR c."citation_key" IN (
          SELECT "citation_key" FROM affected WHERE "citation_key" IS NOT NULL
        )
   );--> statement-breakpoint
UPDATE "case_law_decisions"
   SET "decision_date" = NULL,
       "indexed_hash" = NULL
 WHERE "decision_date" >= ((now() AT TIME ZONE 'UTC')::date + 2);--> statement-breakpoint

-- Replace the CHECK with the tightened ceiling. The expression below is the
-- rendering of `decisionDateWithinBoundsSql` (apps/api/src/lib/decision-date-bounds-sql.ts),
-- which `decision-date-bounds-sql.db.test.ts` compares against this file.
-- NOT VALID here, VALIDATE below, for the same reason as 20260818090000:
-- adding a validating CHECK scans every row under ACCESS EXCLUSIVE.
--
-- Re-runnable as a pair: a second run drops the validated constraint, adds
-- it NOT VALID again and validates it below; the outcome is the same.
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
  ) NOT VALID;--> statement-breakpoint

-- Validate outside Drizzle's migration transaction so PostgreSQL does not
-- hold the ADD CONSTRAINT lock for the duration of the table scan. VALIDATE
-- takes SHARE UPDATE EXCLUSIVE, which concurrent readers and writers do not
-- wait on, and is a no-op on an already validated constraint. Same shape as
-- 20260818090000.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
-- Re-runnable as it stands: the guarded block above is skipped once the
-- tightened constraint exists, and validating a validated constraint changes
-- nothing.
-- squawk-ignore prefer-robust-stmts
ALTER TABLE "case_law_decisions" VALIDATE CONSTRAINT "case_law_decisions_decision_date_bounds";--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
