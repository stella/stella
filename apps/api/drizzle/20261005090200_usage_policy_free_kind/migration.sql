-- requires: 20261003120100_organization_member_capacity
-- requires: 20261003122400_organization_file_usage
-- requires: 20261003123500_configured_access
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- usage_policies is an operator-seeded catalog bounded to a handful of rows
-- (not tenant data), so inline validation completes in microseconds.
-- stella-migration-safety: reviewed drop-constraint - drops only this check,
-- re-added in the next statement with one more accepted value
ALTER TABLE "usage_policies" DROP CONSTRAINT "usage_policies_kind_domain";--> statement-breakpoint
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE "usage_policies" ADD CONSTRAINT "usage_policies_kind_domain" CHECK (kind IN ('subscription', 'addon', 'free'));--> statement-breakpoint

-- The free floor is never checkout-able, costs nothing, and bounds every
-- limit it applies. No existing row has the new kind.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE "usage_policies" ADD CONSTRAINT "usage_policies_free_shape" CHECK (kind <> 'free' OR (hosted_policy_ref IS NULL AND COALESCE(price_amount_cents, 0) = 0 AND max_members IS NOT NULL AND storage_bytes_per_assignment IS NOT NULL AND service_actions_per_period IS NOT NULL));--> statement-breakpoint

-- At most one active free policy: the floor every lapsed organization reads.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX "usage_policies_free_active_uidx" ON "usage_policies" USING btree ("kind") WHERE kind = 'free' AND active;
