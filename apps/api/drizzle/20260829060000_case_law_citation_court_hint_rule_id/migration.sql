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
--> statement-breakpoint

-- The same omission, one table over: `CITATION_CENSUS_RULE_BUCKETS` spreads
-- `CITATION_RESOLUTION_RULES`, so the census gained the rule bucket at the
-- same commit and its constraint was not widened either. A census run that
-- counts a court-hint resolution would fail on the row it writes.
-- The other two branches are unchanged; they are restated because a CHECK
-- can only be replaced whole.
-- stella-migration-safety: reviewed drop-constraint - drops only this check
-- constraint by name and re-adds it with the rule branch widened in the same
-- statement, so no running API task ever observes the column unconstrained;
-- no row data is touched. Rollback is the same statement with `court-hint`
-- removed, which is safe once no row holds that bucket.
ALTER TABLE "case_law_citation_resolution_census"
  DROP CONSTRAINT IF EXISTS "case_law_citation_resolution_census_bucket_values",
  ADD CONSTRAINT "case_law_citation_resolution_census_bucket_values"
  CHECK (
    ("kind" = 'status' AND "bucket" IN ('pending', 'resolved', 'unmatched', 'ambiguous'))
    OR ("kind" = 'rule' AND "bucket" IN ('unique-key', 'type-hint', 'court-hint', 'one-file-merits', 'unattributed'))
    OR ("kind" = 'shape' AND "bucket" IN ('at-cap', 'cross-court', 'untyped', 'one-file-merits', 'orders-only', 'merits-only', 'other'))
  ) NOT VALID;
