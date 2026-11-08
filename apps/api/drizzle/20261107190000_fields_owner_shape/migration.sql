SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "fields" ADD CONSTRAINT "fields_owner_fields_check" CHECK (("owner_run_id" IS NULL) = ("owner_batch_id" IS NULL) AND ("owner_run_id" IS NULL) = ("deadline_at" IS NULL) AND ("owner_run_id" IS NULL) = ("attempt" IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "fields" ADD CONSTRAINT "fields_owner_pending_check" CHECK ("owner_run_id" IS NULL OR "content"->>'type' = 'pending') NOT VALID;
