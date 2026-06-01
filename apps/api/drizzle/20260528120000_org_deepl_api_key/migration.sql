ALTER TABLE "organization_settings"
ADD COLUMN "deepl_api_key_encrypted" bytea,
ADD COLUMN "deepl_api_key_iv" bytea;
