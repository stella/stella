CREATE TABLE "scheduler_jobs" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"task" varchar(128) NOT NULL,
	"description" text,
	"schedule" jsonb NOT NULL,
	"payload" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"last_error" text,
	"locked_at" timestamp with time zone,
	"locked_until" timestamp with time zone,
	"locked_by" varchar(128),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scheduler_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "scheduler_job_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" varchar(128) NOT NULL,
	"task" varchar(128) NOT NULL,
	"runner_id" varchar(128) NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "scheduler_job_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "infosoud_tracked_cases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"court_code" varchar(16) NOT NULL,
	"spis_zn" varchar(64) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"last_sync_attempt_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"last_sync_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "infosoud_tracked_cases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "agenda_kind" text;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "start_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "end_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "occurred_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "remind_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "all_day" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "time_zone" varchar(64);--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "location" text;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "online_meeting_url" text;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "availability" text;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "sensitivity" text;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "organizer" jsonb;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "attendees" jsonb;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "recurrence" jsonb;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "agenda_source" text;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "external_source" varchar(64);--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "external_id" varchar(256);--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "external_change_key" varchar(512);--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "external_ical_uid" varchar(512);--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "external_data" jsonb;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "read_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduler_job_runs" ADD CONSTRAINT "scheduler_job_runs_job_id_scheduler_jobs_id_fkey" FOREIGN KEY ("job_id") REFERENCES "scheduler_jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "infosoud_tracked_cases" ADD CONSTRAINT "infosoud_tracked_cases_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "infosoud_tracked_cases" ADD CONSTRAINT "infosoud_tracked_cases_created_by_user_id_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION;--> statement-breakpoint
CREATE INDEX "scheduler_jobs_enabled_next_run_idx" ON "scheduler_jobs" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX "scheduler_jobs_task_idx" ON "scheduler_jobs" USING btree ("task");--> statement-breakpoint
CREATE INDEX "scheduler_jobs_locked_until_idx" ON "scheduler_jobs" USING btree ("locked_until");--> statement-breakpoint
CREATE INDEX "scheduler_job_runs_job_started_idx" ON "scheduler_job_runs" USING btree ("job_id","started_at");--> statement-breakpoint
CREATE INDEX "scheduler_job_runs_status_started_idx" ON "scheduler_job_runs" USING btree ("status","started_at");--> statement-breakpoint
CREATE INDEX "infosoud_tracked_cases_workspace_idx" ON "infosoud_tracked_cases" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "infosoud_tracked_cases_enabled_sync_idx" ON "infosoud_tracked_cases" USING btree ("enabled","last_sync_attempt_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "infosoud_tracked_cases_workspace_case_uidx" ON "infosoud_tracked_cases" USING btree ("workspace_id","court_code","spis_zn");--> statement-breakpoint
CREATE INDEX "entities_agenda_kind_idx" ON "entities" USING btree ("workspace_id","agenda_kind") WHERE "agenda_kind" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "entities_agenda_start_at_idx" ON "entities" USING btree ("workspace_id","start_at") WHERE "start_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "entities_agenda_occurred_at_idx" ON "entities" USING btree ("workspace_id","occurred_at") WHERE "occurred_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "entities_agenda_external_uidx" ON "entities" USING btree ("workspace_id","external_source","external_id") WHERE "external_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "entities_agenda_ical_uid_idx" ON "entities" USING btree ("workspace_id","external_ical_uid") WHERE "external_ical_uid" IS NOT NULL;--> statement-breakpoint
CREATE POLICY "scheduler_jobs_no_stella_access" ON "scheduler_jobs" AS PERMISSIVE FOR ALL TO "stella" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "scheduler_job_runs_no_stella_access" ON "scheduler_job_runs" AS PERMISSIVE FOR ALL TO "stella" USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "workspace_select" ON "infosoud_tracked_cases" AS PERMISSIVE FOR SELECT TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "infosoud_tracked_cases" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "infosoud_tracked_cases" AS PERMISSIVE FOR UPDATE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "infosoud_tracked_cases" AS PERMISSIVE FOR DELETE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));
