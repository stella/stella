-- requires: 20260603104021_usage_entitlements
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "usage_entitlements" ADD COLUMN "hosted_entitlement_created_at" timestamp with time zone;
