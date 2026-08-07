SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "work_obligations" (
  "entity_id" uuid PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL,
  "type" text DEFAULT 'task' NOT NULL,
  "status" text DEFAULT 'unassigned' NOT NULL,
  "owner_user_id" text,
  "acknowledged_at" timestamptz,
  "acknowledged_by_user_id" text,
  "working_target_date" date,
  "hard_deadline_date" date,
  "source_type" text DEFAULT 'manual' NOT NULL,
  "source_entity_id" uuid,
  "source_description" varchar(1000),
  "created_by_user_id" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "work_obligations_entity_ws_unq" UNIQUE("entity_id", "workspace_id"),
  CONSTRAINT "work_obligations_type_check" CHECK ("type" IN ('task', 'deadline')),
  CONSTRAINT "work_obligations_status_check" CHECK ("status" IN ('unassigned', 'awaiting_acknowledgement', 'active', 'completed', 'cancelled')),
  CONSTRAINT "work_obligations_source_type_check" CHECK ("source_type" IN ('manual', 'calendar', 'email', 'document', 'import', 'api')),
  CONSTRAINT "work_obligations_target_before_deadline_check" CHECK ("working_target_date" IS NULL OR "hard_deadline_date" IS NULL OR "working_target_date" <= "hard_deadline_date"),
  CONSTRAINT "work_obligations_acknowledgement_pair_check" CHECK (("acknowledged_at" IS NULL) = ("acknowledged_by_user_id" IS NULL)),
  CONSTRAINT "work_obligations_state_coherence_check" CHECK (("status" = 'unassigned' AND "owner_user_id" IS NULL AND "acknowledged_at" IS NULL) OR ("status" = 'awaiting_acknowledgement' AND "owner_user_id" IS NOT NULL AND "acknowledged_at" IS NULL) OR ("status" = 'active' AND "owner_user_id" IS NOT NULL AND "acknowledged_at" IS NOT NULL AND "acknowledged_by_user_id" = "owner_user_id") OR "status" IN ('completed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "work_obligation_events" (
  "id" uuid PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL,
  "obligation_entity_id" uuid NOT NULL,
  "actor_user_id" text,
  "type" text NOT NULL,
  "details" jsonb NOT NULL,
  "reason" varchar(1000),
  "occurred_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "work_obligation_events_type_check" CHECK ("type" IN ('created', 'owner_assigned', 'acknowledged', 'delegated', 'working_target_changed', 'hard_deadline_changed', 'type_changed', 'provenance_changed', 'completed', 'reopened', 'cancelled'))
);
--> statement-breakpoint

ALTER TABLE "work_obligations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "work_obligation_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "work_obligations" ADD CONSTRAINT "work_obligations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "work_obligations" ADD CONSTRAINT "work_obligations_entity_workspace_fk" FOREIGN KEY ("entity_id", "workspace_id") REFERENCES "entities"("id", "workspace_id") ON DELETE CASCADE ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "work_obligations" ADD CONSTRAINT "work_obligations_source_entity_id_entities_id_fk" FOREIGN KEY ("source_entity_id") REFERENCES "entities"("id") ON DELETE SET NULL ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "work_obligations" ADD CONSTRAINT "work_obligations_source_entity_workspace_fk" FOREIGN KEY ("source_entity_id", "workspace_id") REFERENCES "entities"("id", "workspace_id") ON DELETE NO ACTION ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "work_obligations" ADD CONSTRAINT "work_obligations_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "work_obligations" ADD CONSTRAINT "work_obligations_acknowledged_by_user_id_user_id_fk" FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "work_obligations" ADD CONSTRAINT "work_obligations_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "work_obligation_events" ADD CONSTRAINT "work_obligation_events_obligation_workspace_fk" FOREIGN KEY ("obligation_entity_id", "workspace_id") REFERENCES "work_obligations"("entity_id", "workspace_id") ON DELETE CASCADE ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "work_obligation_events" ADD CONSTRAINT "work_obligation_events_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION;--> statement-breakpoint

CREATE INDEX "work_obligations_ws_owner_status_target_entity_idx" ON "work_obligations" ("workspace_id", "owner_user_id", "status", "working_target_date", "entity_id");--> statement-breakpoint
CREATE INDEX "work_obligations_owner_status_due_entity_ws_idx" ON "work_obligations" ("owner_user_id", "status", COALESCE("hard_deadline_date", "working_target_date", '9999-12-31'::date), "entity_id", "workspace_id");--> statement-breakpoint
CREATE INDEX "work_obligations_ws_status_deadline_entity_idx" ON "work_obligations" ("workspace_id", "status", "hard_deadline_date", "entity_id") WHERE "hard_deadline_date" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "work_obligation_events_ws_obligation_occurred_id_idx" ON "work_obligation_events" ("workspace_id", "obligation_entity_id", "occurred_at", "id");--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "work_obligations" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "work_obligation_events" TO stella;--> statement-breakpoint

CREATE POLICY "workspace_select" ON "work_obligations" AS PERMISSIVE FOR SELECT TO "stella" USING ("workspace_id" = ANY((SELECT pg_catalog.current_setting('app.workspace_ids', true))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "work_obligations" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK ("workspace_id" = ANY((SELECT pg_catalog.current_setting('app.workspace_ids', true))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "work_obligations" AS PERMISSIVE FOR UPDATE TO "stella" USING ("workspace_id" = ANY((SELECT pg_catalog.current_setting('app.workspace_ids', true))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "work_obligations" AS PERMISSIVE FOR DELETE TO "stella" USING ("workspace_id" = ANY((SELECT pg_catalog.current_setting('app.workspace_ids', true))::uuid[]));--> statement-breakpoint

CREATE POLICY "work_obligation_events_select" ON "work_obligation_events" AS PERMISSIVE FOR SELECT TO "stella" USING ("workspace_id" = ANY((SELECT pg_catalog.current_setting('app.workspace_ids', true))::uuid[]));--> statement-breakpoint
CREATE POLICY "work_obligation_events_insert" ON "work_obligation_events" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK ("workspace_id" = ANY((SELECT pg_catalog.current_setting('app.workspace_ids', true))::uuid[]));--> statement-breakpoint
CREATE POLICY "work_obligation_events_no_update" ON "work_obligation_events" AS RESTRICTIVE FOR UPDATE TO "stella" USING (false);--> statement-breakpoint
CREATE POLICY "work_obligation_events_no_delete" ON "work_obligation_events" AS RESTRICTIVE FOR DELETE TO "stella" USING (false);
