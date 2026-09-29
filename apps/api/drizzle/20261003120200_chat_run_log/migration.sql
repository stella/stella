SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "chat_run_logs" (
  "organization_id" text NOT NULL,
  "run_id" text NOT NULL,
  "turn_id" uuid NOT NULL REFERENCES "chat_turns"("id") ON DELETE CASCADE,
  "next_seq" bigint DEFAULT 1 NOT NULL,
  "bytes_used" bigint DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "closed_at" timestamptz,
  CONSTRAINT "chat_run_logs_pkey" PRIMARY KEY ("organization_id", "run_id"),
  CONSTRAINT "chat_run_logs_next_seq_check" CHECK ("next_seq" > 0),
  CONSTRAINT "chat_run_logs_bytes_used_check" CHECK ("bytes_used" >= 0)
);--> statement-breakpoint
CREATE INDEX "chat_run_logs_closed_at_idx" ON "chat_run_logs" ("closed_at", "organization_id", "run_id") WHERE "closed_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "chat_run_logs_turn_id_idx" ON "chat_run_logs" ("turn_id");--> statement-breakpoint
ALTER TABLE "chat_run_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_run_logs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "chat_run_logs_owner_access" ON "chat_run_logs" AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.chat_run_logs'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.chat_run_logs'::regclass));--> statement-breakpoint

CREATE TABLE "chat_run_log_entries" (
  "organization_id" text NOT NULL,
  "run_id" text NOT NULL,
  "seq" bigint NOT NULL,
  "batch_id" uuid NOT NULL,
  "batch_index" integer NOT NULL,
  "chunk" jsonb NOT NULL,
  CONSTRAINT "chat_run_log_entries_pkey" PRIMARY KEY ("organization_id", "run_id", "seq"),
  CONSTRAINT "chat_run_log_entries_batch_index_check" CHECK ("batch_index" >= 0),
  CONSTRAINT "chat_run_log_entries_seq_check" CHECK ("seq" > 0),
  CONSTRAINT "chat_run_log_entries_log_fk" FOREIGN KEY ("organization_id", "run_id") REFERENCES "chat_run_logs"("organization_id", "run_id") ON DELETE CASCADE
);--> statement-breakpoint
CREATE UNIQUE INDEX "chat_run_log_entries_batch_uidx" ON "chat_run_log_entries" ("organization_id", "run_id", "batch_id", "batch_index");--> statement-breakpoint
ALTER TABLE "chat_run_log_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_run_log_entries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "chat_run_log_entries_owner_access" ON "chat_run_log_entries" AS PERMISSIVE FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.chat_run_log_entries'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.chat_run_log_entries'::regclass));
