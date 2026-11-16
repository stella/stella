SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint

-- The chat files an enqueue stored for a queued message's inline files, so
-- removing the message deletes exactly those. A constant default adds the
-- column without rewriting the table; old API tasks never read it.
ALTER TABLE "chat_queued_messages" ADD COLUMN "uploaded_file_ids" uuid[] DEFAULT '{}' NOT NULL;
