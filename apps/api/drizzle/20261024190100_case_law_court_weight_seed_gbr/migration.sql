SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

UPDATE "case_law_court_weights" w
SET "tier" = v.tier, "tier_label" = v.tier_label, "weight" = v.weight
FROM (VALUES
  ('GBR', '^uksc$|^ukpc$|^ukhl$|^supreme court( of the united kingdom)?$|^judicial committee of the privy council$|^house of lords$', 3, 'supreme', 8),
  ('GBR', '^ewca( civ| crim)?$|^court of appeal( \(civil division\)| \(criminal division\))?$', 2, 'appeal', 5),
  ('GBR', '^ewhc($| )|^ukut($| )|^eat$|^high court( of justice)?($| )|^upper tribunal($| )|^employment appeal tribunal$', 2, 'regional', 4),
  ('GBR', '^ukftt($| )|^ewfc$|^ewcop$|^first-tier tribunal($| )|^family court$|^court of protection$', 1, 'district', 2)
) AS v ("country", "court_pattern", "tier", "tier_label", "weight")
WHERE w."country" = v.country AND w."court_pattern" = v.court_pattern
  AND (w."tier", w."tier_label", w."weight") IS DISTINCT FROM (v.tier, v.tier_label, v.weight);
--> statement-breakpoint
-- stella-migration-safety: reviewed insert-select - the source relation is a 4-row VALUES list, not a table, so the statement is bounded and instant; rollback deletes the same (country, court_pattern) keys
INSERT INTO "case_law_court_weights" ("id", "country", "court_pattern", "tier", "tier_label", "weight")
SELECT gen_random_uuid(), v.country, v.court_pattern, v.tier, v.tier_label, v.weight
FROM (VALUES
  ('GBR', '^uksc$|^ukpc$|^ukhl$|^supreme court( of the united kingdom)?$|^judicial committee of the privy council$|^house of lords$', 3, 'supreme', 8),
  ('GBR', '^ewca( civ| crim)?$|^court of appeal( \(civil division\)| \(criminal division\))?$', 2, 'appeal', 5),
  ('GBR', '^ewhc($| )|^ukut($| )|^eat$|^high court( of justice)?($| )|^upper tribunal($| )|^employment appeal tribunal$', 2, 'regional', 4),
  ('GBR', '^ukftt($| )|^ewfc$|^ewcop$|^first-tier tribunal($| )|^family court$|^court of protection$', 1, 'district', 2)
) AS v ("country", "court_pattern", "tier", "tier_label", "weight")
WHERE NOT EXISTS (
  SELECT 1 FROM "case_law_court_weights" w
  WHERE w."country" = v.country AND w."court_pattern" = v.court_pattern
);
