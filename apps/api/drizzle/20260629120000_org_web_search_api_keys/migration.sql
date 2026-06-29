SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "organization_settings"
ADD COLUMN "web_search_api_key_encrypted" bytea,
ADD COLUMN "web_search_api_key_iv" bytea,
ADD COLUMN "url_fetch_api_key_encrypted" bytea,
ADD COLUMN "url_fetch_api_key_iv" bytea;
