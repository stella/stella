SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Widen GBR's decision-date floor to 1600; all existing bounds remain accepted.
-- The expression mirrors decisionDateWithinBoundsSql and is checked by
-- decision-date-bounds-sql.db.test.ts. The NOT VALID replacement is enforced
-- on new writes; decision-date-ceiling-repair.ts validates it online.
--
-- The metadata-only swap needs ACCESS EXCLUSIVE on the active corpus table.
-- Reuse the bounded, escalating lock waits of the previous floor migration,
-- logging every fifth failed attempt. Only this block has a 10-minute budget;
-- the short lock and statement budgets are restored afterwards.
SET statement_timeout = '10min';--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - the same constraint is re-added NOT VALID in the same block with a floor that only widens; the drop exists only so the expression can change, and no row is written between the two
DO $$
DECLARE
  attempts integer := 0;
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
            AND ("decision_date" >= make_date(1800, 1, 1) OR "country" IN ('GBR', 'USA'))
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
          RAISE WARNING 'decision-date floor: attempt % could not lock case_law_decisions',
            attempts;
        END IF;
        PERFORM pg_sleep(1 + random() * 2);
    END;
  END LOOP;
END
$$;--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';
