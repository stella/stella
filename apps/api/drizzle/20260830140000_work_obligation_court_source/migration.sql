SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- `court` joins WORK_OBLIGATION_SOURCES so a deadline that came from a court
-- registry stops being recorded as `manual`. The schema builds this CHECK from
-- that list, so the constraint the database enforces has to be widened in step
-- or every court-sourced obligation write is rejected.
--
-- NOT VALID: this only widens the accepted set, so every stored row already
-- satisfies the new constraint and there is nothing to scan; it still applies
-- to every later INSERT and UPDATE. Dropped by name and re-added in one
-- statement so no running API task observes the column unconstrained, and a
-- second run re-records the same constraint.
-- stella-migration-safety: reviewed drop-constraint - drops only this check constraint by name and re-adds it with `court` added in the same statement; no row data is touched. Rollback is the same statement with `court` removed, which is safe once no row holds that value.
ALTER TABLE "work_obligations"
  DROP CONSTRAINT IF EXISTS "work_obligations_source_type_check",
  ADD CONSTRAINT "work_obligations_source_type_check"
  CHECK ("source_type" IN ('manual', 'calendar', 'email', 'document', 'court', 'import', 'api')) NOT VALID;
