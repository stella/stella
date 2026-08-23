SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
CREATE TABLE "signals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"workspace_id" uuid,
	"kind" text NOT NULL,
	"origin" text NOT NULL,
	"scout_key" text NOT NULL,
	"severity" text NOT NULL,
	"confidence" real,
	"title" varchar(512) NOT NULL,
	"summary" text NOT NULL,
	"subject" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"suggestions" jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"snoozed_until" timestamp with time zone,
	"assignee_user_id" text,
	"created_by_user_id" text,
	"dismiss_reason" text,
	"accepted_result" jsonb,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signals_id_org_unq" UNIQUE("id","organization_id"),
	CONSTRAINT "signals_confidence_range" CHECK ("confidence" is null or ("confidence" >= 0 and "confidence" <= 1)),
	CONSTRAINT "signals_model_has_confidence" CHECK ("origin" <> 'model' or "confidence" is not null),
	CONSTRAINT "signals_status_check" CHECK ("status" in ('new', 'snoozed', 'accepted', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE "signal_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"signal_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor_user_id" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scout_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"scout_key" text NOT NULL,
	"status" text NOT NULL,
	"emitted_count" integer DEFAULT 0 NOT NULL,
	"inserted_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "signals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "signal_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scout_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_workspace_organization_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "workspaces"("id","organization_id") ON DELETE CASCADE ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_assignee_user_id_user_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "signal_events" ADD CONSTRAINT "signal_events_signal_fk" FOREIGN KEY ("signal_id","organization_id") REFERENCES "signals"("id","organization_id") ON DELETE CASCADE ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "signal_events" ADD CONSTRAINT "signal_events_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "scout_runs" ADD CONSTRAINT "scout_runs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE NO ACTION;--> statement-breakpoint
CREATE UNIQUE INDEX "signals_org_dedupe_uidx" ON "signals" USING btree ("organization_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "signals_org_status_created_idx" ON "signals" USING btree ("organization_id","status","created_at" DESC,"id");--> statement-breakpoint
CREATE INDEX "signals_ws_status_created_idx" ON "signals" USING btree ("workspace_id","status","created_at" DESC,"id");--> statement-breakpoint
CREATE INDEX "signals_assignee_idx" ON "signals" USING btree ("assignee_user_id","status");--> statement-breakpoint
CREATE INDEX "signal_events_signal_created_idx" ON "signal_events" USING btree ("signal_id","created_at");--> statement-breakpoint
CREATE INDEX "scout_runs_org_scout_started_idx" ON "scout_runs" USING btree ("organization_id","scout_key","started_at" DESC);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "signals" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "signal_events" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "scout_runs" TO stella;--> statement-breakpoint
CREATE POLICY "organization_select" ON "signals" AS PERMISSIVE FOR SELECT TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_insert" ON "signals" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_update" ON "signals" AS PERMISSIVE FOR UPDATE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_delete" ON "signals" AS PERMISSIVE FOR DELETE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "signal_events_select" ON "signal_events" AS PERMISSIVE FOR SELECT TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "signal_events_insert" ON "signal_events" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "signal_events_no_update" ON "signal_events" AS RESTRICTIVE FOR UPDATE TO "stella" USING (false);--> statement-breakpoint
CREATE POLICY "signal_events_no_delete" ON "signal_events" AS RESTRICTIVE FOR DELETE TO "stella" USING (false);--> statement-breakpoint
CREATE POLICY "organization_select" ON "scout_runs" AS PERMISSIVE FOR SELECT TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_insert" ON "scout_runs" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_update" ON "scout_runs" AS PERMISSIVE FOR UPDATE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));--> statement-breakpoint
CREATE POLICY "organization_delete" ON "scout_runs" AS PERMISSIVE FOR DELETE TO "stella" USING (organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )));
