-- requires: 20261005090000_hosted_checkout_claims
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "hosted_checkout_claims"
  ADD COLUMN "hosted_checkout_url" text,
  ADD COLUMN "usage_policy_id" uuid,
  ADD COLUMN "seats" integer;
--> statement-breakpoint

-- Existing rows have a NULL URL, so every one satisfies this check.
-- NOT VALID avoids a scan under the additive DDL lock; writes enforce it immediately.
ALTER TABLE "hosted_checkout_claims"
  ADD CONSTRAINT "hosted_checkout_claims_url_has_session_check" CHECK (
    hosted_checkout_url IS NULL OR hosted_session_id IS NOT NULL
  ) NOT VALID;
