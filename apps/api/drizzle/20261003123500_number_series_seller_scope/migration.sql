-- requires: 20261003122100_number_series
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
-- squawk-ignore require-concurrent-index-deletion -- Small organization settings table; atomic replacement preserves uniqueness throughout.
DROP INDEX "number_series_org_type_default_uidx";--> statement-breakpoint
-- squawk-ignore require-concurrent-index-creation -- Small organization settings table; bounded transactional build preserves atomic replacement.
CREATE UNIQUE INDEX "number_series_org_type_default_uidx" ON "number_series" ("organization_id", "document_type") WHERE "is_default" AND "archived_at" IS NULL AND "seller_profile_id" IS NULL;--> statement-breakpoint
-- squawk-ignore require-concurrent-index-creation -- Small organization settings table; bounded transactional build preserves atomic replacement.
CREATE UNIQUE INDEX "number_series_org_type_seller_default_uidx" ON "number_series" ("organization_id", "document_type", "seller_profile_id") WHERE "is_default" AND "archived_at" IS NULL AND "seller_profile_id" IS NOT NULL;
