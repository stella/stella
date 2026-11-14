SET lock_timeout = '1s';
SET statement_timeout = '5min';

ALTER TABLE "fields" ADD COLUMN "owner_run_id" text;
ALTER TABLE "fields" ADD COLUMN "owner_batch_id" text;
ALTER TABLE "fields" ADD COLUMN "deadline_at" timestamptz;
ALTER TABLE "fields" ADD COLUMN "attempt" smallint;
