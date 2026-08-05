SET lock_timeout = '1s';--> statement-breakpoint
-- Validation scans existing compactions without blocking normal reads or
-- writes. The new nullable tenant column is empty on pre-feature rows, so the
-- scan does not need a backfill and may run without a statement timeout.
SET statement_timeout = 0;--> statement-breakpoint
ALTER TABLE "chat_thread_compactions" VALIDATE CONSTRAINT "chat_compactions_memory_extraction_org_fk";
--> statement-breakpoint
SET statement_timeout = '5s';
