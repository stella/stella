SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Court rank for USA alone: its rows of the declaration in
-- apps/api/src/handlers/case-law/court-weight-seed.ts, rendered by
-- courtWeightJurisdictionSeedSql('USA') and held to it by
-- court-weight-seed.test.ts. A row an older seed left at another rank is
-- brought to the declared one, then the missing rows are added on the
-- (country, court_pattern) unique index, so both are re-runnable. Both read a
-- VALUES list of USA rows only and nothing is deleted, so no row of another
-- jurisdiction is written; rollback deletes the same keys.
UPDATE "case_law_court_weights" w
SET "tier" = v.tier, "tier_label" = v.tier_label, "weight" = v.weight
FROM (VALUES
  ('USA', '^supreme court of the united states$', 4, 'constitutional', 10)
) AS v ("country", "court_pattern", "tier", "tier_label", "weight")
WHERE w."country" = v.country AND w."court_pattern" = v.court_pattern
  AND (w."tier", w."tier_label", w."weight") IS DISTINCT FROM (v.tier, v.tier_label, v.weight);
--> statement-breakpoint
-- stella-migration-safety: reviewed insert-select - the source relation is a 1-row VALUES list, not a table, so the statement is bounded and instant; rollback deletes the same (country, court_pattern) keys
INSERT INTO "case_law_court_weights" ("id", "country", "court_pattern", "tier", "tier_label", "weight")
SELECT gen_random_uuid(), v.country, v.court_pattern, v.tier, v.tier_label, v.weight
FROM (VALUES
  ('USA', '^supreme court of the united states$', 4, 'constitutional', 10)
) AS v ("country", "court_pattern", "tier", "tier_label", "weight")
WHERE NOT EXISTS (
  SELECT 1 FROM "case_law_court_weights" w
  WHERE w."country" = v.country AND w."court_pattern" = v.court_pattern
);
