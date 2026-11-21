-- requires: 20261004120300_personal_api_keys
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "organization_settings" VALIDATE CONSTRAINT "organization_settings_personal_api_key_policy_check";
