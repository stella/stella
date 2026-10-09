SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "desktop_time_entry_batches"
  ADD COLUMN "status" text DEFAULT 'committed' NOT NULL,
  ALTER COLUMN "request_fingerprint" DROP NOT NULL,
  ALTER COLUMN "result" DROP NOT NULL,
  ADD CONSTRAINT "desktop_time_entry_batches_status_check" CHECK (
    ("status" = 'committed' AND "request_fingerprint" IS NOT NULL AND "result" IS NOT NULL)
    OR ("status" = 'cancelled' AND "request_fingerprint" IS NULL AND "result" IS NULL)
  );
