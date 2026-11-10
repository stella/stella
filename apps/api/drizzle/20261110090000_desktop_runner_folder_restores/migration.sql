SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A member's request to put a chat's folder back as the checkpoint a run took
-- before its turn, sent to the run's computer and answered by it. Only the
-- table owner reads or writes it, like the other desktop runner tables. A
-- turn has at most one request that is queued, sent or restored; a refused or
-- expired one can be asked again.
CREATE TABLE "desktop_runner_folder_restores" (
  "id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "chat_thread_id" uuid NOT NULL,
  "chat_turn_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "desktop_id" uuid NOT NULL,
  "device_jkt" text NOT NULL,
  "state" text NOT NULL,
  "reason" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "settled_at" timestamptz,
  "noted_run_id" uuid,
  "noted_at" timestamptz,
  CONSTRAINT "desktop_runner_folder_restores_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "desktop_runner_folder_restores_chat_thread_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "chat_threads"("id") ON DELETE cascade,
  CONSTRAINT "desktop_runner_folder_restores_chat_turn_fk" FOREIGN KEY ("chat_turn_id") REFERENCES "chat_turns"("id") ON DELETE cascade,
  CONSTRAINT "desktop_runner_folder_restores_run_fk" FOREIGN KEY ("run_id") REFERENCES "desktop_runner_runs"("run_id") ON DELETE cascade,
  CONSTRAINT "desktop_runner_folder_restores_noted_run_fk" FOREIGN KEY ("noted_run_id") REFERENCES "desktop_runner_runs"("run_id") ON DELETE set null,
  CONSTRAINT "desktop_runner_folder_restores_runner_fk" FOREIGN KEY ("user_id", "organization_id", "desktop_id", "device_jkt") REFERENCES "desktop_runners"("user_id", "organization_id", "desktop_id", "device_jkt") ON DELETE cascade,
  CONSTRAINT "desktop_runner_folder_restores_state_check" CHECK ("state" IN ('queued','sent','restored','refused','expired')),
  CONSTRAINT "desktop_runner_folder_restores_reason_check" CHECK (("state" = 'refused') = ("reason" IS NOT NULL) AND ("reason" IS NULL OR "reason" IN ('no_checkpoint','not_newest','folder_busy','failed'))),
  CONSTRAINT "desktop_runner_folder_restores_settled_check" CHECK (("state" IN ('restored','refused','expired')) = ("settled_at" IS NOT NULL)),
  CONSTRAINT "desktop_runner_folder_restores_noted_check" CHECK (("noted_at" IS NULL AND "noted_run_id" IS NULL) OR "state" = 'restored')
);--> statement-breakpoint
CREATE UNIQUE INDEX "desktop_runner_folder_restores_live_run_idx" ON "desktop_runner_folder_restores" USING btree ("run_id") WHERE "state" IN ('queued','sent','restored');--> statement-breakpoint
CREATE INDEX "desktop_runner_folder_restores_runner_state_idx" ON "desktop_runner_folder_restores" USING btree ("user_id", "organization_id", "desktop_id", "device_jkt", "state");--> statement-breakpoint
CREATE INDEX "desktop_runner_folder_restores_chat_thread_idx" ON "desktop_runner_folder_restores" USING btree ("chat_thread_id", "state");--> statement-breakpoint
CREATE INDEX "desktop_runner_folder_restores_chat_turn_idx" ON "desktop_runner_folder_restores" USING btree ("chat_turn_id");--> statement-breakpoint
CREATE INDEX "desktop_runner_folder_restores_noted_run_idx" ON "desktop_runner_folder_restores" USING btree ("noted_run_id") WHERE "noted_at" IS NULL;--> statement-breakpoint

ALTER TABLE "desktop_runner_folder_restores" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "desktop_runner_folder_restores" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "desktop_runner_folder_restores_owner_access" ON "desktop_runner_folder_restores" FOR ALL TO public
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.desktop_runner_folder_restores'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.desktop_runner_folder_restores'::regclass));--> statement-breakpoint
CREATE POLICY "auth_no_stella_access" ON "desktop_runner_folder_restores" FOR ALL TO "stella" USING (false) WITH CHECK (false);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "desktop_runner_folder_restores" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "desktop_runner_folder_restores" FROM stella;--> statement-breakpoint

-- A desktop now refuses a run with `folder_busy` while the chat's folder is
-- being restored, which DESKTOP_RUNNER_STORED_REJECT_REASONS lists. Dropped by
-- name and re-added in one statement, so no running API task observes the
-- column unconstrained. It only widens the accepted set, so every stored row
-- already satisfies it; desktop_runner_runs holds few rows (ended runs are
-- pruned), so validating it here reads them within the timeouts above.
-- stella-migration-safety: reviewed drop-constraint - drops only this check constraint by name and re-adds it with `folder_busy` added in the same statement; no row data is touched. Rollback is the same statement without it, which is safe once no row holds that value.
ALTER TABLE "desktop_runner_runs"
  DROP CONSTRAINT IF EXISTS "desktop_runner_runs_reject_reason_check",
  -- squawk-ignore constraint-missing-not-valid
  ADD CONSTRAINT "desktop_runner_runs_reject_reason_check"
  CHECK (("state" = 'rejected') = ("reject_reason" IS NOT NULL) AND ("reject_reason" IS NULL OR "reject_reason" IN ('harness_not_installed','harness_needs_login','harness_limited','harness_unsupported','harness_unavailable','harness_version_unavailable','model_unavailable','policy_unsupported','at_capacity','run_too_large','unknown_run','folder_busy')));
