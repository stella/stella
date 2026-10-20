SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE "case_law_decisions"
  ADD COLUMN "decision_date_state" text,
  ADD COLUMN "decision_date_published" varchar(2048);

ALTER TABLE "case_law_decisions"
  ADD CONSTRAINT "case_law_decisions_decision_date_state_values"
  CHECK ("decision_date_state" IN ('dated', 'undated', 'invalid')) NOT VALID,
  ADD CONSTRAINT "case_law_decisions_decision_date_state_consistent"
  CHECK (
    ("decision_date_state" = 'dated' AND "decision_date" IS NOT NULL AND "decision_date_published" IS NULL)
    OR ("decision_date_state" = 'undated' AND "decision_date" IS NULL AND "decision_date_published" IS NULL)
    OR ("decision_date_state" = 'invalid' AND "decision_date" IS NULL AND "decision_date_published" IS NOT NULL)
  ) NOT VALID;
