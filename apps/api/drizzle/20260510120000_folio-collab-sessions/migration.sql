CREATE TABLE "folio_collab_sessions" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"base_version_id" uuid NOT NULL,
	"finalized_version_id" uuid,
	"created_by" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"file_name" varchar(256) NOT NULL,
	"yjs_snapshot_file_id" uuid NOT NULL,
	"yjs_snapshot_size_bytes" integer,
	"yjs_snapshot_updated_at" timestamp,
	"docx_checkpoint_file_id" uuid NOT NULL,
	"docx_checkpoint_sha256_hex" varchar(64),
	"docx_checkpoint_size_bytes" integer,
	"docx_checkpoint_scan_warnings" jsonb,
	"docx_checkpoint_updated_at" timestamp,
	"seed_claimed_by" text,
	"seed_claimed_at" timestamp,
	"seeded_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"closed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "folio_collab_sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "folio_collab_session_tokens" (
	"id" uuid PRIMARY KEY,
	"session_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"permissions" jsonb NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "folio_collab_session_tokens" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "folio_collab_sessions" ADD CONSTRAINT "folio_collab_sessions_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "folio_collab_sessions" ADD CONSTRAINT "folio_collab_sessions_base_version_id_entity_versions_id_fkey" FOREIGN KEY ("base_version_id") REFERENCES "entity_versions"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "folio_collab_sessions" ADD CONSTRAINT "folio_collab_sessions_finalized_version_id_entity_versions_id_fkey" FOREIGN KEY ("finalized_version_id") REFERENCES "entity_versions"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "folio_collab_sessions" ADD CONSTRAINT "folio_collab_sessions_created_by_user_id_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "folio_collab_sessions" ADD CONSTRAINT "folio_collab_sessions_seed_claimed_by_user_id_fkey" FOREIGN KEY ("seed_claimed_by") REFERENCES "user"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "folio_collab_sessions" ADD CONSTRAINT "folio_collab_sessions_entity_workspace_fkey" FOREIGN KEY ("entity_id","workspace_id") REFERENCES "entities"("id","workspace_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "folio_collab_sessions" ADD CONSTRAINT "folio_collab_sessions_property_workspace_fkey" FOREIGN KEY ("property_id","workspace_id") REFERENCES "properties"("id","workspace_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "folio_collab_session_tokens" ADD CONSTRAINT "folio_collab_session_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "folio_collab_sessions"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "folio_collab_session_tokens" ADD CONSTRAINT "folio_collab_session_tokens_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "folio_collab_session_tokens" ADD CONSTRAINT "folio_collab_session_tokens_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX "folio_collab_sessions_workspace_id_idx" ON "folio_collab_sessions" ("workspace_id");
--> statement-breakpoint
CREATE INDEX "folio_collab_sessions_entity_id_idx" ON "folio_collab_sessions" ("entity_id");
--> statement-breakpoint
CREATE INDEX "folio_collab_sessions_property_id_idx" ON "folio_collab_sessions" ("property_id");
--> statement-breakpoint
CREATE INDEX "folio_collab_sessions_base_version_id_idx" ON "folio_collab_sessions" ("base_version_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "folio_collab_sessions_open_uidx" ON "folio_collab_sessions" ("workspace_id","entity_id","property_id") WHERE "folio_collab_sessions"."status" = 'open';
--> statement-breakpoint
CREATE INDEX "folio_collab_session_tokens_workspace_id_idx" ON "folio_collab_session_tokens" ("workspace_id");
--> statement-breakpoint
CREATE INDEX "folio_collab_session_tokens_session_id_idx" ON "folio_collab_session_tokens" ("session_id");
--> statement-breakpoint
CREATE INDEX "folio_collab_session_tokens_expires_at_idx" ON "folio_collab_session_tokens" ("expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "folio_collab_session_tokens_token_hash_uidx" ON "folio_collab_session_tokens" ("token_hash");
--> statement-breakpoint
CREATE POLICY "workspace_select" ON "folio_collab_sessions" AS PERMISSIVE FOR SELECT TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));
--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "folio_collab_sessions" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));
--> statement-breakpoint
CREATE POLICY "workspace_update" ON "folio_collab_sessions" AS PERMISSIVE FOR UPDATE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));
--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "folio_collab_sessions" AS PERMISSIVE FOR DELETE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));
--> statement-breakpoint
CREATE POLICY "workspace_select" ON "folio_collab_session_tokens" AS PERMISSIVE FOR SELECT TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));
--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "folio_collab_session_tokens" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));
--> statement-breakpoint
CREATE POLICY "workspace_update" ON "folio_collab_session_tokens" AS PERMISSIVE FOR UPDATE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));
--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "folio_collab_session_tokens" AS PERMISSIVE FOR DELETE TO "stella" USING (workspace_id = ANY((SELECT current_setting(
  'app.workspace_ids', true
))::uuid[]));
