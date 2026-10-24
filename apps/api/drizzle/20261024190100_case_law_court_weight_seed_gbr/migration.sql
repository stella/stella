SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Initial GBR ranks only: preserve any rows already seeded by the CLI.
-- Literal identities and timestamps keep fresh and upgraded catalogs aligned.
INSERT INTO "case_law_court_weights" ("id", "country", "court_pattern", "tier", "tier_label", "weight", "created_at")
VALUES
  ('d795830f-e524-46f5-8ca7-c152008a5599', 'GBR', '^uksc$|^ukpc$|^ukhl$|^supreme court( of the united kingdom)?$|^judicial committee of the privy council$|^house of lords$', 3, 'supreme', 8, '2026-10-24T00:00:00Z'),
  ('5cc04aab-a407-4045-af50-9f9a953ca815', 'GBR', '^ewca( civ| crim)?$|^court of appeal( \(civil division\)| \(criminal division\))?$', 2, 'appeal', 5, '2026-10-24T00:00:00Z'),
  ('d741d3bf-b800-4f9b-b295-4487d1957f45', 'GBR', '^ewhc($| )|^ukut($| )|^eat$|^high court( of justice)?($| )|^upper tribunal($| )|^employment appeal tribunal$', 2, 'regional', 4, '2026-10-24T00:00:00Z'),
  ('c4b6c468-11fa-49bc-8906-4854b8ddf8aa', 'GBR', '^ukftt($| )|^ewfc$|^ewcop$|^first-tier tribunal($| )|^family court$|^court of protection$', 1, 'district', 2, '2026-10-24T00:00:00Z')
ON CONFLICT DO NOTHING;
