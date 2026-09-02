SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Court rank per jurisdiction: the declaration in
-- apps/api/src/handlers/case-law/court-weight-seed.ts, rendered by
-- courtWeightSeedInsertSql() and held to it by court-weight-seed.test.ts.
-- Idempotent on the (country, court_pattern) unique index, so a database
-- seeded by the script keeps its rows.
-- stella-migration-safety: reviewed insert-select - the source relation is a fourteen-row VALUES list, not a table, so the statement is bounded and instant; rollback deletes the same (country, court_pattern) keys
INSERT INTO "case_law_court_weights" ("id", "country", "court_pattern", "tier", "tier_label", "weight")
SELECT gen_random_uuid(), v.country, v.court_pattern, v.tier, v.tier_label, v.weight
FROM (VALUES
  ('CZE', 'ústavní soud', 4, 'constitutional', 10),
  ('CZE', 'nejvyšší', 3, 'supreme', 8),
  ('CZE', 'vrchní soud|krajský soud|městský soud', 2, 'regional', 4),
  ('SVK', 'ústavný súd', 4, 'constitutional', 10),
  ('SVK', 'najvyšší', 3, 'supreme', 8),
  ('SVK', 'krajský súd', 2, 'regional', 4),
  ('POL', 'trybunał konstytucyjny', 4, 'constitutional', 10),
  ('POL', 'sąd najwyższy|naczelny sąd administracyjny', 3, 'supreme', 8),
  ('POL', 'sąd apelacyjny|sąd okręgowy', 2, 'regional', 4),
  ('AUT', 'verfassungsgerichtshof|^vfgh$', 4, 'constitutional', 10),
  ('AUT', 'oberster gerichtshof|verwaltungsgerichtshof|^ogh$|^vwgh$', 3, 'supreme', 8),
  ('AUT', 'oberlandesgericht|landesgericht', 2, 'regional', 4),
  ('EU', 'court of justice', 4, 'constitutional', 10),
  ('EU', 'general court', 3, 'supreme', 8)
) AS v ("country", "court_pattern", "tier", "tier_label", "weight")
WHERE NOT EXISTS (
  SELECT 1 FROM "case_law_court_weights" w
  WHERE w."country" = v.country AND w."court_pattern" = v.court_pattern
);
