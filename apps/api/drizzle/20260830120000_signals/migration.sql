SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "document_processing_runs" ADD COLUMN "deadline_scout_status" text DEFAULT 'not_requested' NOT NULL;--> statement-breakpoint
ALTER TABLE "document_processing_runs" ADD COLUMN "deadline_scout_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "document_processing_runs" ADD COLUMN "deadline_scout_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document_processing_runs" ADD COLUMN "deadline_scout_error_code" varchar(128);--> statement-breakpoint
-- The three checks below constrain only the four columns added immediately
-- above, which land with NOT NULL defaults or NULL. Every pre-existing row
-- therefore satisfies them by construction and validation cannot fail; the
-- statement_timeout set at the top bounds how long the validating scan may
-- hold ACCESS EXCLUSIVE, so an oversized table aborts the migration instead
-- of stalling writers.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE "document_processing_runs" ADD CONSTRAINT "document_processing_runs_deadline_scout_status_values_check" CHECK ("deadline_scout_status" IN ('not_requested', 'pending', 'running', 'succeeded', 'failed', 'cancelled'));--> statement-breakpoint
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE "document_processing_runs" ADD CONSTRAINT "document_processing_runs_deadline_scout_attempt_nonneg_check" CHECK ("deadline_scout_attempt_count" >= 0);--> statement-breakpoint
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE "document_processing_runs" ADD CONSTRAINT "document_processing_runs_deadline_scout_lifecycle_check" CHECK ((("deadline_scout_status" = 'not_requested' AND "deadline_scout_claimed_at" IS NULL AND "deadline_scout_error_code" IS NULL) OR ("deadline_scout_status" = 'pending' AND "deadline_scout_claimed_at" IS NULL) OR ("deadline_scout_status" = 'running' AND "deadline_scout_claimed_at" IS NOT NULL AND "deadline_scout_error_code" IS NULL) OR ("deadline_scout_status" IN ('succeeded', 'cancelled') AND "deadline_scout_claimed_at" IS NULL) OR ("deadline_scout_status" = 'failed' AND "deadline_scout_claimed_at" IS NULL AND "deadline_scout_error_code" IS NOT NULL)));--> statement-breakpoint
-- Both scout queue indexes are partial on a status no pre-existing row holds,
-- so each builds with zero entries. CONCURRENTLY would require splitting the
-- migrator's wrapping transaction; the build blocks writes only for the
-- bounded scan the statement_timeout above already caps, and reads stay
-- available.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "document_processing_runs_deadline_scout_pending_idx" ON "document_processing_runs" USING btree ("updated_at","id") WHERE "deadline_scout_status" = 'pending';--> statement-breakpoint
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "document_processing_runs_deadline_scout_running_idx" ON "document_processing_runs" USING btree ("deadline_scout_claimed_at","id") WHERE "deadline_scout_status" = 'running';--> statement-breakpoint
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
	CONSTRAINT "signals_kind_check" CHECK ("kind" in ('request.submitted', 'hearing.changed', 'deadline.detected', 'contract.reviewed')),
	CONSTRAINT "signals_origin_check" CHECK ("origin" in ('manual', 'source', 'model')),
	CONSTRAINT "signals_severity_check" CHECK ("severity" in ('info', 'notice', 'warning', 'critical')),
	CONSTRAINT "signals_kind_origin_check" CHECK (("kind" = 'request.submitted' AND "origin" = 'manual') OR ("kind" = 'hearing.changed' AND "origin" = 'source') OR ("kind" = 'deadline.detected' AND "origin" = 'model') OR ("kind" = 'contract.reviewed' AND "origin" = 'model')),
	CONSTRAINT "signals_status_check" CHECK ("status" in ('new', 'snoozed', 'accepted', 'dismissed')),
	CONSTRAINT "signals_lifecycle_check" CHECK ((("status" = 'new' AND "snoozed_until" IS NULL AND "resolved_at" IS NULL AND "accepted_result" IS NULL AND "dismiss_reason" IS NULL) OR ("status" = 'snoozed' AND "snoozed_until" IS NOT NULL AND "resolved_at" IS NULL AND "accepted_result" IS NULL AND "dismiss_reason" IS NULL) OR ("status" = 'accepted' AND "snoozed_until" IS NULL AND "resolved_at" IS NOT NULL AND "accepted_result" IS NOT NULL AND "dismiss_reason" IS NULL) OR ("status" = 'dismissed' AND "snoozed_until" IS NULL AND "resolved_at" IS NOT NULL AND "accepted_result" IS NULL)))
);
--> statement-breakpoint
CREATE TABLE "signal_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"signal_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor_user_id" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signal_events_type_check" CHECK ("type" in ('created', 'snoozed', 'unsnoozed', 'accepted', 'dismissed', 'assigned'))
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
	"finished_at" timestamp with time zone,
	CONSTRAINT "scout_runs_status_check" CHECK ("status" in ('running', 'succeeded', 'failed'))
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
CREATE INDEX "signals_created_by_user_idx" ON "signals" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "signal_events_signal_created_idx" ON "signal_events" USING btree ("signal_id","created_at");--> statement-breakpoint
CREATE INDEX "signal_events_actor_user_idx" ON "signal_events" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "scout_runs_org_scout_started_idx" ON "scout_runs" USING btree ("organization_id","scout_key","started_at" DESC);--> statement-breakpoint
CREATE INDEX "scout_runs_running_scout_started_idx" ON "scout_runs" USING btree ("scout_key","started_at","id") WHERE "status" = 'running';--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "signals" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "signal_events" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "scout_runs" TO stella;--> statement-breakpoint
CREATE POLICY "signals_scope_select" ON "signals" AS PERMISSIVE FOR SELECT TO "stella" USING (
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND (
    workspace_id IS NULL
    OR CASE
      WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
      THEN true
      ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
    END
  )
);--> statement-breakpoint
CREATE POLICY "signals_scope_insert" ON "signals" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND (
    workspace_id IS NULL
    OR CASE
      WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
      THEN true
      ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
    END
  )
);--> statement-breakpoint
CREATE POLICY "signals_scope_update" ON "signals" AS PERMISSIVE FOR UPDATE TO "stella" USING (
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND (
    workspace_id IS NULL
    OR CASE
      WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
      THEN true
      ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
    END
  )
);--> statement-breakpoint
CREATE POLICY "signals_scope_delete" ON "signals" AS PERMISSIVE FOR DELETE TO "stella" USING (
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND (
    workspace_id IS NULL
    OR CASE
      WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
      THEN true
      ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
    END
  )
);--> statement-breakpoint
CREATE POLICY "signal_events_select" ON "signal_events" AS PERMISSIVE FOR SELECT TO "stella" USING (
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND EXISTS (
    SELECT 1
    FROM signals
    WHERE signals.id = signal_events.signal_id
      AND signals.organization_id = signal_events.organization_id
  )
);--> statement-breakpoint
CREATE POLICY "signal_events_insert" ON "signal_events" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (
  organization_id = (SELECT current_setting('app.organization_id', true))
  AND EXISTS (
    SELECT 1
    FROM signals
    WHERE signals.id = signal_events.signal_id
      AND signals.organization_id = signal_events.organization_id
  )
);--> statement-breakpoint
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
