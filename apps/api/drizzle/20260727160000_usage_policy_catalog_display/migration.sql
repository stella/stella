SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "usage_policies" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "usage_policies" ADD COLUMN "kind" text DEFAULT 'subscription' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_policies" ADD COLUMN "price_amount_cents" integer;--> statement-breakpoint
ALTER TABLE "usage_policies" ADD COLUMN "price_currency" varchar(3);--> statement-breakpoint
ALTER TABLE "usage_policies" ADD COLUMN "billing_interval" text;--> statement-breakpoint
ALTER TABLE "usage_policies" ADD COLUMN "visibility" text DEFAULT 'hidden' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_policies" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- stella-migration-safety: reviewed constraint validation - usage_policies is an
-- operator-seeded catalog bounded to a handful of rows (not tenant data), so
-- inline CHECK validation completes in microseconds and cannot block under load.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE "usage_policies" ADD CONSTRAINT "usage_policies_price_amount_nonneg" CHECK (price_amount_cents IS NULL OR price_amount_cents >= 0);--> statement-breakpoint
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE "usage_policies" ADD CONSTRAINT "usage_policies_price_fields_consistent" CHECK ((price_amount_cents IS NULL) = (price_currency IS NULL) AND (price_amount_cents IS NULL) = (billing_interval IS NULL));--> statement-breakpoint
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE "usage_policies" ADD CONSTRAINT "usage_policies_kind_domain" CHECK (kind IN ('subscription', 'addon'));--> statement-breakpoint
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE "usage_policies" ADD CONSTRAINT "usage_policies_billing_interval_domain" CHECK (billing_interval IS NULL OR billing_interval IN ('month', 'year', 'one_time'));--> statement-breakpoint
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE "usage_policies" ADD CONSTRAINT "usage_policies_visibility_domain" CHECK (visibility IN ('public', 'hidden'));
