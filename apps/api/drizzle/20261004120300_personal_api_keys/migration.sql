-- requires: 20261004120200_validate_uploaded_mail_correspondence
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "personal_api_key_policy" text DEFAULT 'enabled' NOT NULL;
--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_personal_api_key_policy_check" CHECK ("personal_api_key_policy" IN ('enabled', 'disabled')) NOT VALID;
--> statement-breakpoint
-- squawk-ignore transaction-nesting
COMMIT;
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = 0;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "apikey_personal_owner_keyset_idx" ON "apikey" (((metadata::jsonb ->> 'organizationId')), reference_id, created_at DESC, id DESC) WHERE metadata IS NOT NULL AND metadata::jsonb ->> 'kind' = 'personal';
--> statement-breakpoint
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;
