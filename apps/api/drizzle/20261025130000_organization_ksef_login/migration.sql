SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE "organization_settings"
  ADD COLUMN "ksef_login_encrypted" bytea,
  ADD COLUMN "ksef_login_iv" bytea,
  ADD COLUMN "ksef_login_kind" text,
  ADD COLUMN "ksef_login_target" text,
  ADD COLUMN "ksef_login_nip" text,
  ADD COLUMN "ksef_certificate_subject" text,
  ADD COLUMN "ksef_certificate_valid_from" timestamptz,
  ADD COLUMN "ksef_certificate_valid_to" timestamptz,
  ADD COLUMN "ksef_login_set_at" timestamptz,
  ADD COLUMN "ksef_login_set_by" text;

ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_ksef_login_kind_check"
  CHECK ("ksef_login_kind" IS NULL OR "ksef_login_kind" IN ('token', 'certificate')) NOT VALID;
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_ksef_login_target_check"
  CHECK ("ksef_login_target" IS NULL OR "ksef_login_target" IN ('test', 'demo', 'production')) NOT VALID;
