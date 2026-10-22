-- requires: 20261022120000_professional_use_acceptance_source
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

-- stella-migration-safety: reviewed insert-select - inserts at most one acceptance per eligible account, excludes fixed synthetic principals and the review organization, and converges through both the anti-join and primary-key conflict guard.
INSERT INTO user_professional_use_acceptances
  (user_id, statement_version, terms_version, source)
SELECT u.id, '2026-10', '2026-10', 'owner_backfill_2026_10_22'
FROM "user" u
WHERE NOT EXISTS (
    SELECT 1 FROM user_professional_use_acceptances a WHERE a.user_id = u.id
  )
  AND u.id NOT IN (
    'smoke-user-stella',
    'smoke-ai-user-stella',
    'synthetic-prod-user'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM member m
    INNER JOIN organization o ON o.id = m.organization_id
    WHERE m.user_id = u.id
      AND m.role = 'owner'
      AND o.name = 'Sample law firm'
      AND o.slug = 'review-' || lower(o.id)
  )
ON CONFLICT ON CONSTRAINT user_professional_use_acceptances_pkey DO NOTHING;
