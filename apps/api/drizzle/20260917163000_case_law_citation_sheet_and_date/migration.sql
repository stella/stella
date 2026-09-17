SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- One docket names a case file, and a court can rule in it more than once, so
-- the docket alone leaves those decisions indistinguishable and the resolver
-- links none of them. The citing text says which one it means: the sheet the
-- document sits on, which is the last segment of that decision's ECLI, or the
-- date the sentence gives it. Both were read off the sentence and discarded;
-- these columns keep them, beside the court and decision-type hints the
-- resolver already adjudicates by.
ALTER TABLE "case_law_citations"
  ADD COLUMN "cited_sheet_number" varchar(8);--> statement-breakpoint
ALTER TABLE "case_law_citations"
  ADD COLUMN "cited_decision_date" date;--> statement-breakpoint

-- Digits only, so the column holds a sheet number and never the tail of
-- whatever else a dash happened to precede. The resolver builds its LIKE
-- pattern by concatenating this value, and a digit run carries no LIKE
-- metacharacter.
--
-- NOT VALID, with no VALIDATE to follow: every stored row has NULL here, a
-- CHECK is satisfied by NULL, and this table is registered high-volume, so a
-- validating scan is exactly what must not run here. The constraint applies to
-- every later INSERT and UPDATE, which is every row that can carry a value.
ALTER TABLE "case_law_citations"
  ADD CONSTRAINT "citations_cited_sheet_number_shape"
  CHECK ("cited_sheet_number" ~ '^[0-9]+$') NOT VALID;
--> statement-breakpoint

-- `sheet-number` and `decision-date` join CITATION_RESOLUTION_RULES, and both
-- CHECKs below are built from that list. A rule whose id the database rejects
-- takes the whole resolution statement with it, so the batch aborts and the
-- rows it also covered stay unsettled.
--
-- NOT VALID: widening an IN list accepts every value the old list accepted, so
-- there is nothing to scan. Dropped by name and re-added in one statement, so
-- no running API task observes the column unconstrained. Rollback is the same
-- statement with the two ids removed, which is safe once no row holds them.
-- stella-migration-safety: reviewed drop-constraint - drops only this check
-- constraint by name and re-adds it with a wider value set in the same
-- statement; no row data is touched.
ALTER TABLE "case_law_citations"
  DROP CONSTRAINT IF EXISTS "citations_resolution_rule_id_values",
  ADD CONSTRAINT "citations_resolution_rule_id_values"
  CHECK ("resolution_rule_id" IN ('unique-key', 'sheet-number', 'decision-date', 'type-hint', 'court-hint', 'one-file-merits')) NOT VALID;
--> statement-breakpoint

-- The same list, one table over: CITATION_CENSUS_RULE_BUCKETS spreads
-- CITATION_RESOLUTION_RULES, so the census gains a bucket per rule. A run that
-- counts a sheet-number resolution would fail on the row it writes. The other
-- two branches are unchanged; they are restated because a CHECK can only be
-- replaced whole.
-- stella-migration-safety: reviewed drop-constraint - drops only this check
-- constraint by name and re-adds it with the rule branch widened in the same
-- statement; no row data is touched.
ALTER TABLE "case_law_citation_resolution_census"
  DROP CONSTRAINT IF EXISTS "case_law_citation_resolution_census_bucket_values",
  ADD CONSTRAINT "case_law_citation_resolution_census_bucket_values"
  CHECK (
    ("kind" = 'status' AND "bucket" IN ('pending', 'resolved', 'unmatched', 'ambiguous'))
    OR ("kind" = 'rule' AND "bucket" IN ('unique-key', 'sheet-number', 'decision-date', 'type-hint', 'court-hint', 'one-file-merits', 'unattributed'))
    OR ("kind" = 'shape' AND "bucket" IN ('at-cap', 'cross-court', 'untyped', 'one-file-merits', 'orders-only', 'merits-only', 'other'))
  ) NOT VALID;
