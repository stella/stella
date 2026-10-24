-- requires: 20261003122800_sanctions_monitoring
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Admit 'incomplete' as a screening coverage status: a bounded scan of the
-- current edition that found no match in the part it screened. The CHECK
-- spells the accepted list, so it is replaced rather than added to.
--
-- Both checks are added NOT VALID and validated in the online phase
-- (sanctions-monitoring-constraint-validation.ts), so this transaction holds
-- no scan of the table under its DDL lock.
--
-- stella-migration-safety: reviewed drop-constraint - the same statement adds
-- back a CHECK over a strict superset of the accepted statuses, so every
-- existing row satisfies it and a running task keeps writing the statuses it
-- knows.
ALTER TABLE "sanctions_contact_screenings"
  DROP CONSTRAINT "sanctions_contact_screenings_status_check",
  ADD CONSTRAINT "sanctions_contact_screenings_status_check"
  CHECK (status IN ('clear', 'possible-match', 'unavailable', 'incomplete', 'excluded')) NOT VALID;--> statement-breakpoint

-- An incomplete screening always names the edition it screened. No existing
-- row has the new status.
ALTER TABLE "sanctions_contact_screenings"
  ADD CONSTRAINT "sanctions_contact_screenings_incomplete_edition_check"
  CHECK (status <> 'incomplete' OR edition_id IS NOT NULL) NOT VALID;
