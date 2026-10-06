-- requires: 20261003121500_chat_turn_run_ownership
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "chat_turns"
  ADD COLUMN "timing_message_id" uuid,
  ADD COLUMN "active_duration_ms" bigint,
  ADD COLUMN "active_started_at" timestamptz,
  ADD CONSTRAINT "chat_turns_timing_message_thread_fk" FOREIGN KEY ("timing_message_id", "thread_id") REFERENCES "chat_messages"("id", "thread_id") ON DELETE cascade,
  ADD CONSTRAINT "chat_turns_active_timing_check" CHECK (
    ("active_duration_ms" IS NULL AND "active_started_at" IS NULL) OR
    ("active_duration_ms" IS NOT NULL AND "active_duration_ms" >= 0 AND (("status" IN ('accepted', 'running')) = ("active_started_at" IS NOT NULL)))
  );
--> statement-breakpoint
CREATE INDEX "chat_turns_org_timing_message_idx" ON "chat_turns" ("organization_id", "timing_message_id");
