SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Initial BRA ranks only: preserve any rows already seeded by the CLI.
-- Literal identities and timestamps keep fresh and upgraded catalogs aligned.
INSERT INTO "case_law_court_weights" ("id", "country", "court_pattern", "tier", "tier_label", "weight", "created_at")
VALUES
  ('60fee13f-8aa1-473f-8d19-19dd9047ba58', 'BRA', '^stf$|^supremo tribunal federal$', 4, 'constitutional', 10, '2026-10-25T00:00:00Z'),
  ('24da6f7d-1b7d-44bd-a6c5-8208e9d3ec67', 'BRA', '^(stj|tst|tse|stm)$|^superior tribunal (de justiça|militar)$|^tribunal superior (do trabalho|eleitoral)$', 3, 'supreme', 8, '2026-10-25T00:00:00Z'),
  ('e2a1c44c-e000-4af1-82f1-5f0f4f8c3fa3', 'BRA', '^(tj[a-z]{2}|tjdft|tjm[a-z]{2}|trf[1-6]|trt([1-9]|1[0-9]|2[0-4])|tre-?[a-z]{2})$|^tribunal de justiça |^tribunal regional (federal|do trabalho|eleitoral) ', 2, 'appeal', 5, '2026-10-25T00:00:00Z')
ON CONFLICT DO NOTHING;
