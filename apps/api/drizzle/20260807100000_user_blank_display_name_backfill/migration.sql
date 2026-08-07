-- stella-migration-safety: reviewed bulk-backfill - bounded by a WHERE clause matching only blank-name rows on a table whose row count is the tenant user count, and the value is computed per-row from an already-present column with no joins.
-- Give every account a non-empty display name.
--
-- `user.name` is written once, at signup. Email-OTP signup and some social
-- providers supply no name, and `notNull` still admits the empty string, so
-- those accounts persisted `name = ''`. Signup now defaults the column to the
-- email local-part (`ensureDisplayName` in src/lib/auth.ts), but accounts
-- created before that landed kept the empty value, and no product surface
-- lets a user set `name` afterwards -- account settings only exposes
-- `preferred_name`. Those rows therefore stay blank forever and render as a
-- nameless identity wherever the raw column reaches the UI.
--
-- Backfill with the same rule signup applies, so pre-existing and new
-- accounts converge on one representation: the email local-part, or the full
-- email when the address has no local part to take.
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
UPDATE "user"
  SET name = COALESCE(NULLIF(split_part(email, '@', 1), ''), email)
  WHERE btrim(name) = ''
    AND btrim(email) <> '';
