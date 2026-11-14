SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint

-- A forked thread copies the steps its copied messages show. A fork has
-- messages and no turns, so a copied row is owned by its message instead of
-- a turn and goes with that message. Exactly one of the two owns a row.
ALTER TABLE "chat_local_run_step_contents" ALTER COLUMN "turn_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_local_run_step_contents" ADD COLUMN IF NOT EXISTS "message_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_local_run_step_contents" ADD CONSTRAINT "chat_local_run_step_contents_message_fk" FOREIGN KEY ("message_id", "thread_id") REFERENCES "chat_messages"("id", "thread_id") ON DELETE cascade NOT VALID;--> statement-breakpoint
ALTER TABLE "chat_local_run_step_contents" ADD CONSTRAINT "chat_local_run_step_contents_owner_check" CHECK (num_nonnulls("turn_id", "message_id") = 1) NOT VALID;--> statement-breakpoint
CREATE INDEX "chat_local_run_step_contents_message_idx" ON "chat_local_run_step_contents" USING btree ("message_id") WHERE "message_id" IS NOT NULL;
