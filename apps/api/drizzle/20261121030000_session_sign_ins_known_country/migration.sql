SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '10s';--> statement-breakpoint

-- A known sign-in location must name its country. The previous CHECK tested
-- the country only with a regular expression, which yields NULL for a NULL
-- country, so a known row without one passed. The replacement is added NOT
-- VALID; the registered online phase validates existing rows after deploy.
-- stella-migration-safety: reviewed drop-constraint - Replace the check atomically with its tightened form, added NOT VALID so no existing row is scanned under the lock. Failure before commit restores the original check; retry after commit recreates the same check.
-- squawk-ignore ban-drop-constraint
ALTER TABLE "session_sign_ins" DROP CONSTRAINT IF EXISTS "session_sign_ins_location_check";--> statement-breakpoint
ALTER TABLE "session_sign_ins" ADD CONSTRAINT "session_sign_ins_location_check"
  CHECK (("session_sign_ins"."location_kind" = 'unknown' AND "session_sign_ins"."country_code" IS NULL AND "session_sign_ins"."region" IS NULL AND "session_sign_ins"."city" IS NULL AND "session_sign_ins"."latitude" IS NULL AND "session_sign_ins"."longitude" IS NULL) OR ("session_sign_ins"."location_kind" = 'known' AND "session_sign_ins"."country_code" IS NOT NULL AND "session_sign_ins"."country_code" ~ '^[A-Z]{2}$' AND ("session_sign_ins"."latitude" IS NULL) = ("session_sign_ins"."longitude" IS NULL))) NOT VALID;
