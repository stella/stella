SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The year bounds the write path enforces through `canonicalDecisionDate`
-- (`DECISION_YEAR_BOUNDS` in apps/api/src/lib/dates.ts), enforced at the
-- table. A NULL date is allowed. The ceiling is the first excluded day rather
-- than a year comparison so the same text stays a range predicate over
-- "case_law_decisions_date_idx"; `now()` is read in UTC so the session time
-- zone cannot move the boundary.
--
-- NOT VALID here, VALIDATE below: adding a validating CHECK scans every row
-- while holding ACCESS EXCLUSIVE. NOT VALID takes the lock only long enough to
-- record the constraint, which then applies to every later INSERT and UPDATE.
--
-- Guarded so the file can be re-run: the ADD commits below before the
-- VALIDATE, and a VALIDATE that fails would otherwise leave a second run
-- failing on a constraint that already exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'case_law_decisions_decision_date_bounds'
      AND conrelid = 'case_law_decisions'::regclass
  ) THEN
    ALTER TABLE "case_law_decisions"
      ADD CONSTRAINT "case_law_decisions_decision_date_bounds"
      CHECK (
        "decision_date" IS NULL
        OR (
          "decision_date" >= make_date(1800, 1, 1)
          AND "decision_date" < make_date(
            extract(year from (now() AT TIME ZONE 'UTC'))::int + 2, 1, 1)
        )
      ) NOT VALID;
  END IF;
END
$$;--> statement-breakpoint

-- Validate outside Drizzle's migration transaction so PostgreSQL does not
-- hold the ADD CONSTRAINT lock for the duration of the table scan. VALIDATE
-- takes SHARE UPDATE EXCLUSIVE, which concurrent readers and writers do not
-- wait on, and is a no-op on an already validated constraint. Same shape as
-- 20260817220000_chat_turn_client_tool_interaction.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
-- Re-runnable as it stands: the guarded ADD above is skipped once the
-- constraint exists, and validating a validated constraint changes nothing.
-- squawk-ignore prefer-robust-stmts
ALTER TABLE "case_law_decisions" VALIDATE CONSTRAINT "case_law_decisions_decision_date_bounds";--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
