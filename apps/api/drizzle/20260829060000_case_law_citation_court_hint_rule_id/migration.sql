SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- `court-hint` joined CITATION_RESOLUTION_RULES with the court-hint rule, and
-- the schema's CHECK is built from that list, but no migration ever widened
-- the constraint the database enforces. Every citation the rule settles is
-- therefore written with a `resolution_rule_id` the check rejects, and the
-- rejection takes the whole resolution statement with it: the batch aborts,
-- so the rows it also covered stay unsettled and the next pass re-selects the
-- same batch. The walk cannot step over it, and the ingest-time pass fails the
-- decision that carries such a citation.
--
-- NOT VALID: no stored row can hold `court-hint` (every such write failed), so
-- there is nothing to scan, and the constraint applies to every later INSERT
-- and UPDATE. Dropped by name and re-added in one statement so a second run
-- re-records the same constraint.
-- stella-migration-safety: reviewed drop-constraint - drops only this check
-- constraint by name and re-adds it with a wider value set in the same
-- statement, so no running API task ever observes the column unconstrained;
-- no row data is touched. Rollback is the same statement with `court-hint`
-- removed, which is safe once no row holds that value.
ALTER TABLE "case_law_citations"
  DROP CONSTRAINT IF EXISTS "citations_resolution_rule_id_values",
  ADD CONSTRAINT "citations_resolution_rule_id_values"
  CHECK ("resolution_rule_id" IN ('unique-key', 'type-hint', 'court-hint', 'one-file-merits')) NOT VALID;
