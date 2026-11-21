SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A known sign-in location must name its country. The previous CHECK tested
-- the country only with a regular expression, which yields NULL for a NULL
-- country, so a known row without one passed. The writer always sets the
-- country for a known location, so every stored row satisfies the new form.
--
-- Dropped by name and re-added in one statement, so no running API task
-- observes the table unconstrained. session_sign_ins holds one row per live
-- session, so validating here reads it within the timeouts above.
-- stella-migration-safety: reviewed drop-constraint - drops only this check constraint by name and re-adds it with `country_code IS NOT NULL` in the known branch in the same statement; no row data is touched. Rollback is the same statement without that term.
ALTER TABLE "session_sign_ins"
  DROP CONSTRAINT IF EXISTS "session_sign_ins_location_check",
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "session_sign_ins_location_check" CHECK (("session_sign_ins"."location_kind" = 'unknown' AND "session_sign_ins"."country_code" IS NULL AND "session_sign_ins"."region" IS NULL AND "session_sign_ins"."city" IS NULL AND "session_sign_ins"."latitude" IS NULL AND "session_sign_ins"."longitude" IS NULL) OR ("session_sign_ins"."location_kind" = 'known' AND "session_sign_ins"."country_code" IS NOT NULL AND "session_sign_ins"."country_code" ~ '^[A-Z]{2}$' AND ("session_sign_ins"."latitude" IS NULL) = ("session_sign_ins"."longitude" IS NULL)));
