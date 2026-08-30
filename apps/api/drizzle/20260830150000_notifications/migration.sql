SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"kind" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"idempotency_key" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_kind_check" CHECK ("kind" in ('mention', 'report_export_succeeded', 'report_export_failed', 'flow_run_completed', 'flow_run_failed', 'flow_run_awaiting_approval', 'announcement')),
	CONSTRAINT "notifications_entity_type_check" CHECK ("entity_type" is null or "entity_type" in ('entity', 'flow_run', 'report_export')),
	CONSTRAINT "notifications_entity_pointer_check" CHECK (("entity_type" IS NULL) = ("entity_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE NO ACTION;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_user_idempotency_uidx" ON "notifications" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "notifications_user_org_created_idx" ON "notifications" USING btree ("user_id","organization_id","created_at" DESC,"id");--> statement-breakpoint
CREATE INDEX "notifications_user_org_unread_idx" ON "notifications" USING btree ("user_id","organization_id") WHERE "read_at" IS NULL;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "notifications" TO stella;--> statement-breakpoint
CREATE POLICY "user_select" ON "notifications" AS PERMISSIVE FOR SELECT TO "stella" USING (user_id =
  (SELECT current_setting(
    'app.user_id', true
  )));--> statement-breakpoint
CREATE POLICY "user_insert" ON "notifications" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (user_id =
  (SELECT current_setting(
    'app.user_id', true
  )));--> statement-breakpoint
CREATE POLICY "user_update" ON "notifications" AS PERMISSIVE FOR UPDATE TO "stella" USING (user_id =
  (SELECT current_setting(
    'app.user_id', true
  )));--> statement-breakpoint
CREATE POLICY "user_delete" ON "notifications" AS PERMISSIVE FOR DELETE TO "stella" USING (user_id =
  (SELECT current_setting(
    'app.user_id', true
  )));
