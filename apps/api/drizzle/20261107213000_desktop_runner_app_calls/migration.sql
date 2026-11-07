SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- The calls a local run's MCP token made to a stella tool that a chat app
-- presents, as the server answered them. Reached only through the table
-- owner, like the other desktop runner tables, and deleted with the run.
CREATE TABLE "desktop_runner_app_calls" (
  "run_id" uuid NOT NULL,
  "seq" integer NOT NULL,
  "tool_name" varchar(128) NOT NULL,
  "arguments_hash" char(64) NOT NULL,
  "resource_uri" varchar(256) NOT NULL,
  "result" jsonb NOT NULL,
  "paired_tool_call_id" varchar(256),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "desktop_runner_app_calls_pkey" PRIMARY KEY ("run_id", "seq"),
  CONSTRAINT "desktop_runner_app_calls_run_id_desktop_runner_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "desktop_runner_runs"("run_id") ON DELETE cascade,
  CONSTRAINT "desktop_runner_app_calls_seq_check" CHECK ("seq" BETWEEN 1 AND 16),
  CONSTRAINT "desktop_runner_app_calls_hash_check" CHECK ("arguments_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "desktop_runner_app_calls_result_check" CHECK (jsonb_typeof("result") = 'object')
);--> statement-breakpoint
CREATE UNIQUE INDEX "desktop_runner_app_calls_paired_idx" ON "desktop_runner_app_calls" USING btree ("run_id", "paired_tool_call_id") WHERE "paired_tool_call_id" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "desktop_runner_app_calls" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "desktop_runner_app_calls" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "desktop_runner_app_calls_owner_access" ON "desktop_runner_app_calls" FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.desktop_runner_app_calls'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.desktop_runner_app_calls'::regclass));--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "desktop_runner_app_calls" FOR ALL TO "stella" USING (false) WITH CHECK (false);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "desktop_runner_app_calls" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "desktop_runner_app_calls" FROM stella;
