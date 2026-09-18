SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- `advocate-general` joins DECISION_JUDGE_ROLES. The Court of Justice names
-- an Advocate General on every case it hears and states them as a field of
-- its own, which fits none of the roles the column accepted; an ingest
-- writing one would abort on the check and take the decision's whole bench
-- with it.
--
-- The CHECK spells the contract's list, so it is replaced rather than added
-- to, and this runs after the panel-roles migration: the list here is that
-- one's plus the new member.
--
-- NOT VALID: widening an IN list accepts every value the old list accepted,
-- so there is nothing to scan.
-- stella-migration-safety: reviewed drop-constraint - drops only this check
-- constraint by name and re-adds it over a superset of the accepted values in
-- the same statement, so no row is ever unchecked and a running task keeps
-- writing the roles it knows; rollback replays the narrower list, which
-- validates once the rows carrying the new role are gone.
ALTER TABLE "case_law_decision_judges"
  DROP CONSTRAINT IF EXISTS "case_law_decision_judges_role_values",
  ADD CONSTRAINT "case_law_decision_judges_role_values"
  CHECK ("role" IN ('rapporteur', 'presiding', 'panel-member', 'dissenting', 'advocate-general')) NOT VALID;
