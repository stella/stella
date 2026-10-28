SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Desktop runner sockets, the runs assigned to them, the commands queued for
-- those runs and the messages the desktops sent back. The gateway serves
-- sockets and sweeps leases across organizations, so only the table owner
-- reads or writes these tables.
CREATE TABLE "desktop_runners" (
  "user_id" text NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "desktop_id" uuid NOT NULL,
  "device_jkt" text NOT NULL,
  "session_id" uuid NOT NULL,
  "instance_id" text NOT NULL,
  "connection" text NOT NULL,
  "protocol" integer NOT NULL,
  "app_version" varchar(64) NOT NULL,
  "sidecar_version" varchar(64) NOT NULL,
  "harnesses" jsonb NOT NULL,
  "connected_at" timestamptz NOT NULL,
  "last_seen_at" timestamptz NOT NULL,
  CONSTRAINT "desktop_runners_pkey" PRIMARY KEY ("user_id", "organization_id", "desktop_id"),
  CONSTRAINT "desktop_runners_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade,
  CONSTRAINT "desktop_runners_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade,
  CONSTRAINT "desktop_runners_connection_check" CHECK ("connection" IN ('connected','disconnected')),
  CONSTRAINT "desktop_runners_protocol_check" CHECK ("protocol" >= 0),
  CONSTRAINT "desktop_runners_harnesses_check" CHECK (jsonb_typeof("harnesses") = 'array')
);--> statement-breakpoint

CREATE TABLE "desktop_runner_runs" (
  "run_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "desktop_id" uuid NOT NULL,
  "device_jkt" text NOT NULL,
  "harness" text NOT NULL,
  "harness_version" varchar(64) NOT NULL,
  "workspace_ids" text[] NOT NULL,
  "state" text NOT NULL,
  "outcome" text,
  "reject_reason" text,
  "harness_session_id" varchar(256),
  "accepted_at" timestamptz,
  "ack_seq" bigint DEFAULT 0 NOT NULL,
  "lease_expires_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "desktop_runner_runs_pkey" PRIMARY KEY ("run_id"),
  CONSTRAINT "desktop_runner_runs_runner_fk" FOREIGN KEY ("user_id", "organization_id", "desktop_id") REFERENCES "desktop_runners"("user_id", "organization_id", "desktop_id") ON DELETE cascade,
  CONSTRAINT "desktop_runner_runs_harness_check" CHECK ("harness" IN ('codex','claude-code','opencode')),
  CONSTRAINT "desktop_runner_runs_state_check" CHECK ("state" IN ('assigned','running','waiting_for_computer','finished','rejected','lost')),
  CONSTRAINT "desktop_runner_runs_outcome_check" CHECK (("state" = 'finished') = ("outcome" IS NOT NULL) AND ("outcome" IS NULL OR "outcome" IN ('completed','interrupted','cancelled','failed','limit_reached','needs_login'))),
  CONSTRAINT "desktop_runner_runs_reject_reason_check" CHECK (("state" = 'rejected') = ("reject_reason" IS NOT NULL) AND ("reject_reason" IS NULL OR "reject_reason" IN ('harness_not_installed','harness_needs_login','harness_limited','harness_unsupported','harness_version_unavailable','model_unavailable','policy_unsupported','at_capacity','unknown_run'))),
  CONSTRAINT "desktop_runner_runs_ack_seq_check" CHECK ("ack_seq" BETWEEN 0 AND 4294967295)
);--> statement-breakpoint
CREATE INDEX "desktop_runner_runs_runner_state_idx" ON "desktop_runner_runs" USING btree ("user_id", "organization_id", "desktop_id", "state");--> statement-breakpoint
CREATE INDEX "desktop_runner_runs_lease_idx" ON "desktop_runner_runs" USING btree ("lease_expires_at") WHERE "state" IN ('assigned','running');--> statement-breakpoint

CREATE TABLE "desktop_runner_commands" (
  "id" bigint GENERATED ALWAYS AS IDENTITY
    (SEQUENCE NAME "desktop_runner_commands_id_seq") NOT NULL,
  "run_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "command_key" uuid NOT NULL,
  "payload" jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "desktop_runner_commands_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "desktop_runner_commands_run_id_desktop_runner_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "desktop_runner_runs"("run_id") ON DELETE cascade,
  CONSTRAINT "desktop_runner_commands_kind_check" CHECK ("kind" IN ('run.start','run.input','run.approval','run.interrupt','run.cancel')),
  CONSTRAINT "desktop_runner_commands_payload_check" CHECK (jsonb_typeof("payload") = 'object')
);--> statement-breakpoint
CREATE UNIQUE INDEX "desktop_runner_commands_key_idx" ON "desktop_runner_commands" USING btree ("run_id", "kind", "command_key");--> statement-breakpoint

CREATE TABLE "desktop_runner_events" (
  "run_id" uuid NOT NULL,
  "seq" bigint NOT NULL,
  "type" text NOT NULL,
  "request_id" uuid,
  "message" jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "desktop_runner_events_pkey" PRIMARY KEY ("run_id", "seq"),
  CONSTRAINT "desktop_runner_events_run_id_desktop_runner_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "desktop_runner_runs"("run_id") ON DELETE cascade,
  CONSTRAINT "desktop_runner_events_type_check" CHECK ("type" IN ('run.event','run.approval_request','run.finished')),
  CONSTRAINT "desktop_runner_events_seq_check" CHECK ("seq" BETWEEN 1 AND 4294967295),
  CONSTRAINT "desktop_runner_events_request_check" CHECK (("type" = 'run.approval_request') = ("request_id" IS NOT NULL)),
  CONSTRAINT "desktop_runner_events_message_check" CHECK (jsonb_typeof("message") = 'object')
);--> statement-breakpoint
CREATE UNIQUE INDEX "desktop_runner_events_request_idx" ON "desktop_runner_events" USING btree ("run_id", "request_id") WHERE "request_id" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "desktop_runners" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "desktop_runners" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "desktop_runners_owner_access" ON "desktop_runners" FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.desktop_runners'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.desktop_runners'::regclass));--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "desktop_runners" FOR ALL TO "stella" USING (false) WITH CHECK (false);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "desktop_runners" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "desktop_runners" FROM stella;--> statement-breakpoint

ALTER TABLE "desktop_runner_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "desktop_runner_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "desktop_runner_runs_owner_access" ON "desktop_runner_runs" FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.desktop_runner_runs'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.desktop_runner_runs'::regclass));--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "desktop_runner_runs" FOR ALL TO "stella" USING (false) WITH CHECK (false);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "desktop_runner_runs" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "desktop_runner_runs" FROM stella;--> statement-breakpoint

ALTER TABLE "desktop_runner_commands" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "desktop_runner_commands" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "desktop_runner_commands_owner_access" ON "desktop_runner_commands" FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.desktop_runner_commands'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.desktop_runner_commands'::regclass));--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "desktop_runner_commands" FOR ALL TO "stella" USING (false) WITH CHECK (false);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "desktop_runner_commands" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "desktop_runner_commands" FROM stella;--> statement-breakpoint

ALTER TABLE "desktop_runner_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "desktop_runner_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "desktop_runner_events_owner_access" ON "desktop_runner_events" FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.desktop_runner_events'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.desktop_runner_events'::regclass));--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "desktop_runner_events" FOR ALL TO "stella" USING (false) WITH CHECK (false);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "desktop_runner_events" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "desktop_runner_events" FROM stella;
