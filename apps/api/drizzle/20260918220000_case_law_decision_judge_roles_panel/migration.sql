SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- `presiding` and `panel-member` join the roles a decision may state, for
-- publishers that print the whole bench rather than the rapporteur alone.
-- The CHECK spells the contract's list, so it is replaced rather than added to.
-- stella-migration-safety: reviewed drop-constraint - the same migration adds
-- back a CHECK over a superset of the accepted values in the same statement,
-- so new rows are checked at once and a running task keeps writing the roles
-- it knows; the stored rows are validated by the migration that follows;
-- rollback replays the narrower list, which validates once the rows carrying
-- the two new roles are gone.
ALTER TABLE "case_law_decision_judges"
  DROP CONSTRAINT IF EXISTS "case_law_decision_judges_role_values",
  ADD CONSTRAINT "case_law_decision_judges_role_values"
  CHECK ("role" IN ('rapporteur', 'presiding', 'panel-member', 'dissenting')) NOT VALID;
