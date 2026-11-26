SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- The permission level of a thread's turns on stella's own models; null is Ask.
ALTER TABLE "chat_threads"
  ADD COLUMN IF NOT EXISTS "chat_cloud_approvals" text;--> statement-breakpoint
ALTER TABLE "chat_threads"
  ADD CONSTRAINT "chat_threads_chat_cloud_approvals_check"
  CHECK ("chat_cloud_approvals" IS NULL OR "chat_cloud_approvals" IN ('plan', 'ask', 'auto', 'full_auto')) NOT VALID;
