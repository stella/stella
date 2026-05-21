-- Keep the scoped `stella` role aligned with Better Auth's full-row user
-- reads. RLS still limits which user rows are visible; this grant only
-- extends the column-level allowlist.

GRANT SELECT (
  id,
  name,
  email,
  email_verified,
  image,
  timezone_id,
  preferred_name,
  word_edit_shortcut,
  created_at,
  updated_at
) ON TABLE "user" TO stella;
