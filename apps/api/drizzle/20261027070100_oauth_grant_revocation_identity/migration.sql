SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE "oauth_grant_revocations" ADD COLUMN "grant_id" text;
