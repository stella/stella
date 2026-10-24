SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Widen GBR's floor; existing rows remain accepted. Online repair validates
-- the replacement constraint after deployment.
-- stella-migration-safety: reviewed drop-constraint - the constraint is replaced in the same statement with a wider bound and no intervening writes
ALTER TABLE "case_law_decisions"
  DROP CONSTRAINT "case_law_decisions_decision_date_bounds",
  ADD CONSTRAINT "case_law_decisions_decision_date_bounds"
  CHECK (
    "decision_date" IS NULL OR (
      "decision_date" >= make_date(1600, 1, 1)
      AND ("decision_date" >= make_date(1800, 1, 1) OR "country" IN ('GBR', 'USA'))
      AND "decision_date" < ((now() AT TIME ZONE 'UTC')::date + 2)
    )
  ) NOT VALID;
