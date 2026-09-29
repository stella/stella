SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint

ALTER TABLE "usage_policies"
  VALIDATE CONSTRAINT "usage_policies_storage_bytes_nonneg";
