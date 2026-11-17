SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

CREATE TABLE "legislation_matter_links" (
  "id" uuid PRIMARY KEY NOT NULL,
  "document_id" uuid NOT NULL,
  "statute_id" varchar(512) NOT NULL,
  "provision_id" text NOT NULL,
  "applied_version" date NOT NULL,
  "jurisdiction" varchar(3) NOT NULL,
  "workspace_id" uuid NOT NULL,
  "linked_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "legislation_matter_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legislation_matter_links" ADD CONSTRAINT "legislation_matter_links_document_fk" FOREIGN KEY ("document_id") REFERENCES "public"."legislation_documents"("id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "legislation_matter_links" ADD CONSTRAINT "legislation_matter_links_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "legislation_matter_links" ADD CONSTRAINT "legislation_matter_links_linked_by_user_id_fkey" FOREIGN KEY ("linked_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE UNIQUE INDEX "legislation_matter_links_provision_ws_idx" ON "legislation_matter_links" USING btree ("document_id","provision_id","workspace_id");--> statement-breakpoint
CREATE INDEX "legislation_matter_links_workspace_idx" ON "legislation_matter_links" USING btree ("workspace_id");--> statement-breakpoint
CREATE POLICY "workspace_select" ON "legislation_matter_links" AS PERMISSIVE FOR SELECT TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "legislation_matter_links" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "legislation_matter_links" AS PERMISSIVE FOR UPDATE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "legislation_matter_links" AS PERMISSIVE FOR DELETE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "legislation_matter_links" TO "stella";
