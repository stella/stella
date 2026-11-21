SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- A member can now turn local agents on under Beta Features, so the enrolment
-- feature check gains the feature. The check is replaced by a wider NOT VALID
-- check and validated online.
-- stella-migration-safety: reviewed drop-constraint - the feature id check is immediately replaced by a wider NOT VALID check.
-- squawk-ignore ban-drop-constraint
ALTER TABLE "feature_enrolments" DROP CONSTRAINT IF EXISTS "feature_enrolments_feature_id_check";--> statement-breakpoint
ALTER TABLE "feature_enrolments" ADD CONSTRAINT "feature_enrolments_feature_id_check"
  CHECK ("feature_id" IN ('time-billing', 'local-agents')) NOT VALID;
