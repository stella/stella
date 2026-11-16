SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
-- A member can ask to hear when the usage limit that stopped their chat's
-- turn on their computer resets. Additive: a new per user+org table, plus
-- one more notification kind and pointer type. The kind and entity-type
-- checks are replaced by wider NOT VALID checks and validated online.
CREATE TABLE "chat_limit_reminders" (
	"thread_id" uuid PRIMARY KEY NOT NULL,
	"turn_id" uuid NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"user_id" text NOT NULL,
	"remind_at" timestamptz NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_limit_reminders" ADD CONSTRAINT "chat_limit_reminders_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "chat_threads"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_limit_reminders" ADD CONSTRAINT "chat_limit_reminders_turn_id_chat_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "chat_turns"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_limit_reminders" ADD CONSTRAINT "chat_limit_reminders_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_limit_reminders" ADD CONSTRAINT "chat_limit_reminders_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE INDEX "chat_limit_reminders_remind_at_idx" ON "chat_limit_reminders" ("remind_at");--> statement-breakpoint
CREATE INDEX "chat_limit_reminders_turn_idx" ON "chat_limit_reminders" ("turn_id");--> statement-breakpoint
CREATE INDEX "chat_limit_reminders_org_user_idx" ON "chat_limit_reminders" ("organization_id","user_id");--> statement-breakpoint
ALTER TABLE "chat_limit_reminders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chat_limit_reminders" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chat_limit_reminders" TO stella;--> statement-breakpoint
CREATE POLICY "chat_limit_reminder_owner" ON "chat_limit_reminders" AS PERMISSIVE FOR ALL TO public USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.chat_limit_reminders'::regclass)) WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.chat_limit_reminders'::regclass));--> statement-breakpoint
CREATE POLICY "chat_limit_reminder_select" ON "chat_limit_reminders" AS PERMISSIVE FOR SELECT TO "stella" USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
));--> statement-breakpoint
CREATE POLICY "chat_limit_reminder_insert" ON "chat_limit_reminders" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
));--> statement-breakpoint
CREATE POLICY "chat_limit_reminder_delete" ON "chat_limit_reminders" AS PERMISSIVE FOR DELETE TO "stella" USING ((
  organization_id =
  (SELECT current_setting(
    'app.organization_id', true
  )) AND user_id =
  (SELECT current_setting(
    'app.user_id', true
  ))
));--> statement-breakpoint
CREATE POLICY "chat_limit_reminder_no_update" ON "chat_limit_reminders" AS RESTRICTIVE FOR UPDATE TO "stella" USING (false);--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - the kind check is immediately replaced by a wider NOT VALID check that also accepts local_run_limit_reset; every existing row still satisfies it, and it is validated online.
-- squawk-ignore ban-drop-constraint
ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_kind_check";--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_check"
  CHECK ("kind" in ('mention', 'task_assigned', 'report_export_succeeded', 'report_export_failed', 'flow_run_completed', 'flow_run_failed', 'flow_run_awaiting_approval', 'local_run_limit_reset', 'announcement')) NOT VALID;--> statement-breakpoint
-- stella-migration-safety: reviewed drop-constraint - the entity-type check is immediately replaced by a wider NOT VALID check that also accepts chat_thread; every existing row still satisfies it, and it is validated online.
-- squawk-ignore ban-drop-constraint
ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_entity_type_check";--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_entity_type_check"
  CHECK ("entity_type" is null or "entity_type" in ('chat_thread', 'entity', 'flow_run', 'report_export', 'task')) NOT VALID;
