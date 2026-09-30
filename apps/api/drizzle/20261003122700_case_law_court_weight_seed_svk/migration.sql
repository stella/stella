-- requires: 20260429152450_entity-version-ai-summaries
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Replace the legacy Slovak apex key; other jurisdictions retain their rows.
UPDATE "case_law_court_weights"
SET "court_pattern" = 'najvyšší súd'
WHERE "country" = 'SVK' AND "court_pattern" = 'najvyšší';
--> statement-breakpoint
UPDATE "case_law_court_weights" w
SET "tier" = v.tier, "tier_label" = v.tier_label, "weight" = v.weight
FROM (VALUES
  ('SVK', 'ústavný súd', 4, 'constitutional', 10),
  ('SVK', 'najvyšší súd', 3, 'supreme', 8),
  ('SVK', 'najvyšší správny súd', 3, 'supreme', 8),
  ('SVK', 'krajský súd', 2, 'regional', 4),
  ('SVK', 'okresný súd|mestský súd', 1, 'district', 2),
  ('SVK', 'špecializovaný trestný súd|špeciálny súd', 1, 'special', 3),
  ('SVK', '^správny súd', 1, 'administrative', 3)
) AS v ("country", "court_pattern", "tier", "tier_label", "weight")
WHERE w."country" = v.country AND w."court_pattern" = v.court_pattern
  AND (w."tier", w."tier_label", w."weight") IS DISTINCT FROM (v.tier, v.tier_label, v.weight);
--> statement-breakpoint
-- stella-migration-safety: reviewed insert-select - the source relation is a 7-row VALUES list, not a table, so the statement is bounded and instant; rollback deletes the same (country, court_pattern) keys
INSERT INTO "case_law_court_weights" ("id", "country", "court_pattern", "tier", "tier_label", "weight")
SELECT gen_random_uuid(), v.country, v.court_pattern, v.tier, v.tier_label, v.weight
FROM (VALUES
  ('SVK', 'ústavný súd', 4, 'constitutional', 10),
  ('SVK', 'najvyšší súd', 3, 'supreme', 8),
  ('SVK', 'najvyšší správny súd', 3, 'supreme', 8),
  ('SVK', 'krajský súd', 2, 'regional', 4),
  ('SVK', 'okresný súd|mestský súd', 1, 'district', 2),
  ('SVK', 'špecializovaný trestný súd|špeciálny súd', 1, 'special', 3),
  ('SVK', '^správny súd', 1, 'administrative', 3)
) AS v ("country", "court_pattern", "tier", "tier_label", "weight")
WHERE NOT EXISTS (
  SELECT 1 FROM "case_law_court_weights" w
  WHERE w."country" = v.country AND w."court_pattern" = v.court_pattern
);
