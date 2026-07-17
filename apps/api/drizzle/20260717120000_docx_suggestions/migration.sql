SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
CREATE TABLE "docx_suggestions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"origin_thread_id" uuid,
	"op_payload" jsonb NOT NULL,
	"comment" text,
	"severity" text NOT NULL,
	"area" varchar(128) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"applied_mode" text,
	"resolved_by_user_id" text,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "docx_suggestions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "docx_suggestions" ADD CONSTRAINT "docx_suggestions_entity_fk" FOREIGN KEY ("entity_id","workspace_id") REFERENCES "entities"("id","workspace_id") ON DELETE CASCADE ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "docx_suggestions" ADD CONSTRAINT "docx_suggestions_origin_thread_fk" FOREIGN KEY ("origin_thread_id") REFERENCES "chat_threads"("id") ON DELETE SET NULL ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "docx_suggestions" ADD CONSTRAINT "docx_suggestions_resolved_by_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION;--> statement-breakpoint
CREATE INDEX "docx_suggestions_ws_entity_status_idx" ON "docx_suggestions" USING btree ("workspace_id","entity_id","status");--> statement-breakpoint
CREATE INDEX "docx_suggestions_ws_entity_created_idx" ON "docx_suggestions" USING btree ("workspace_id","entity_id","created_at","id");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "docx_suggestions" TO stella;--> statement-breakpoint
CREATE POLICY "workspace_select" ON "docx_suggestions" AS PERMISSIVE FOR SELECT TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "docx_suggestions" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "docx_suggestions" AS PERMISSIVE FOR UPDATE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "docx_suggestions" AS PERMISSIVE FOR DELETE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));
