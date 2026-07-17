SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- Kept in a separate transaction from ADD ... NOT VALID. ai_memories was
-- created immediately before this sequence, so the validation scan is bounded.
ALTER TABLE "ai_memories" VALIDATE CONSTRAINT "ai_memories_workspace_org_fkey";
