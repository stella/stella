-- requires: 20260603104021_usage_entitlements
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- A suspended snapshot may have no end bound. Its closed interval stores a
-- denying state without inventing a period or granting an allocation.
-- stella-migration-safety: reviewed drop-constraint - The same atomic statement replaces the period check; positive periods remain required for every consuming state.
ALTER TABLE "usage_entitlements"
  DROP CONSTRAINT "usage_entitlements_period_order",
  ADD CONSTRAINT "usage_entitlements_period_order"
  CHECK (current_period_end > current_period_start OR (current_period_end = current_period_start AND status IN ('paused', 'cancelled')));
