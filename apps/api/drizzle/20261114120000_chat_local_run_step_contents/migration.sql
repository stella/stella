SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '10s';--> statement-breakpoint

-- What the steps of a chat's local runs produced (a command's output, a
-- change's diff, a subagent's conversation, an image a step viewed), one row
-- per step of a thread. Text is held encrypted for the thread's organization;
-- an image is a chat file the row names. A row goes with the turn that
-- produced it, and so with that turn's messages and its thread.
-- Reached only through the table owner, like the desktop runner tables: a
-- write settles against its run's budget in the same transaction.
CREATE TABLE "chat_local_run_step_contents" (
  "thread_id" uuid NOT NULL,
  "step_key" varchar(64) NOT NULL,
  "run_id" uuid NOT NULL,
  "turn_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "state" text NOT NULL,
  "total_bytes" bigint NOT NULL,
  "stored_bytes" integer NOT NULL,
  "text_encrypted" bytea,
  "text_iv" bytea,
  "user_file_id" uuid,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "chat_local_run_step_contents_pkey" PRIMARY KEY ("thread_id", "step_key"),
  CONSTRAINT "chat_local_run_step_contents_thread_fk" FOREIGN KEY ("thread_id") REFERENCES "chat_threads"("id") ON DELETE cascade,
  CONSTRAINT "chat_local_run_step_contents_turn_fk" FOREIGN KEY ("turn_id") REFERENCES "chat_turns"("id") ON DELETE cascade,
  CONSTRAINT "chat_local_run_step_contents_user_file_fk" FOREIGN KEY ("user_file_id") REFERENCES "user_files"("id") ON DELETE cascade,
  CONSTRAINT "chat_local_run_step_contents_step_key_check" CHECK ("step_key" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "chat_local_run_step_contents_kind_check" CHECK ("kind" IN ('command','diff','conversation','image')),
  CONSTRAINT "chat_local_run_step_contents_state_check" CHECK ("state" IN ('stored','too_large','run_budget_reached')),
  CONSTRAINT "chat_local_run_step_contents_bytes_check" CHECK ("total_bytes" >= 0 AND "stored_bytes" >= 0 AND "stored_bytes" <= "total_bytes"),
  CONSTRAINT "chat_local_run_step_contents_content_check" CHECK (("text_encrypted" IS NULL) = ("text_iv" IS NULL) AND ("text_encrypted" IS NOT NULL) = ("state" = 'stored' AND "kind" <> 'image') AND ("user_file_id" IS NOT NULL) = ("state" = 'stored' AND "kind" = 'image') AND ("state" = 'stored' OR "stored_bytes" = 0))
);--> statement-breakpoint
CREATE INDEX "chat_local_run_step_contents_turn_idx" ON "chat_local_run_step_contents" USING btree ("turn_id");--> statement-breakpoint
CREATE INDEX "chat_local_run_step_contents_user_file_idx" ON "chat_local_run_step_contents" USING btree ("user_file_id") WHERE "user_file_id" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "chat_local_run_step_contents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_local_run_step_contents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "chat_local_run_step_contents_owner_access" ON "chat_local_run_step_contents" FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.chat_local_run_step_contents'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.chat_local_run_step_contents'::regclass));--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "chat_local_run_step_contents" FOR ALL TO "stella" USING (false) WITH CHECK (false);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "chat_local_run_step_contents" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "chat_local_run_step_contents" FROM stella;--> statement-breakpoint

-- What one run has stored of its steps' content, bounded per run. Constant
-- defaults add the columns in the catalog without rewriting a row.
ALTER TABLE "desktop_runner_runs" ADD COLUMN IF NOT EXISTS "step_content_text_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "desktop_runner_runs" ADD COLUMN IF NOT EXISTS "step_content_images" integer DEFAULT 0 NOT NULL;
