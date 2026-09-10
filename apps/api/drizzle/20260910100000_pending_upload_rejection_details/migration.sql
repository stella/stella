SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "pending_uploads" ADD COLUMN "rejection_details" jsonb;
