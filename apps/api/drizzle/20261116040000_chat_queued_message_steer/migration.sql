SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint

-- The revision of a queued message handed to a running turn as a steer, so
-- the run's report removes exactly that revision. A nullable column without
-- a default rewrites no rows; old API tasks never read it.
ALTER TABLE "chat_queued_messages" ADD COLUMN "steered_revision" integer;
