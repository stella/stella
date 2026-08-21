-- The decision-type word a citing text introduced the number with ("nález
-- sp. zn. …", "usnesením … č. j. …"), kept from extraction so the resolver
-- can tell the nález from the orders that share its docket number without
-- inferring it from the file's structure. Null means the text did not say.
-- Rows extracted before this column exist get a hint only when their
-- decision is re-extracted.
ALTER TABLE "case_law_citations" ADD COLUMN IF NOT EXISTS "cited_decision_type_hint" varchar(16);

-- NOT VALID: every existing row is null, so there is nothing to scan, and
-- the constraint applies to every later INSERT and UPDATE. Dropped by name
-- and re-added in one statement so a second run re-records the same
-- constraint.
-- stella-migration-safety: reviewed destructive-change - drops only this
-- migration's own check constraint by name immediately before re-adding
-- it; no row data is touched.
ALTER TABLE "case_law_citations"
  DROP CONSTRAINT IF EXISTS "citations_cited_decision_type_hint_values",
  ADD CONSTRAINT "citations_cited_decision_type_hint_values"
  CHECK ("cited_decision_type_hint" IN ('nález', 'usnesení', 'rozsudek', 'stanovisko')) NOT VALID;
