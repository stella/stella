SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "scheduler_jobs" ADD CONSTRAINT "scheduler_jobs_lease_fields_check" CHECK (("locked_by" IS NULL) = ("locked_at" IS NULL) AND ("locked_by" IS NULL) = ("locked_until" IS NULL)) NOT VALID;
