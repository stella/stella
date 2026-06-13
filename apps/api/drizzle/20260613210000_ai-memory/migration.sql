CREATE TABLE "ai_memories" (
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"scope" text NOT NULL,
	"user_id" text,
	"workspace_id" uuid,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"language" varchar(10),
	"source_data_workspace_ids" uuid[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	"source_message_id" uuid,
	"confidence" double precision,
	"created_by" text,
	"superseded_by_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp DEFAULT now() NOT NULL,
	"archived_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "chat_thread_compactions" ADD COLUMN "memory_extracted_at" timestamp;--> statement-breakpoint
ALTER TABLE "ai_memories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ai_memories" TO stella;--> statement-breakpoint
CREATE INDEX "ai_memories_org_scope_status_idx" ON "ai_memories" ("organization_id", "scope", "status");--> statement-breakpoint
CREATE INDEX "ai_memories_user_status_idx" ON "ai_memories" ("user_id", "status") WHERE user_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ai_memories_workspace_status_idx" ON "ai_memories" ("workspace_id", "status") WHERE workspace_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_source_message_id_chat_messages_id_fkey" FOREIGN KEY ("source_message_id") REFERENCES "chat_messages"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_created_by_user_id_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_superseded_by_id_ai_memories_id_fkey" FOREIGN KEY ("superseded_by_id") REFERENCES "ai_memories"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_scope_ids_check" CHECK (
	(scope = 'organization' AND user_id IS NULL AND workspace_id IS NULL)
	OR (scope = 'user' AND user_id IS NOT NULL AND workspace_id IS NULL)
	OR (scope = 'workspace' AND workspace_id IS NOT NULL AND user_id IS NULL)
);--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_kind_scope_check" CHECK (kind IN ('preference', 'instruction') OR scope = 'workspace');--> statement-breakpoint
CREATE POLICY "ai_memory_select" ON "ai_memories" AS PERMISSIVE FOR SELECT TO "stella" USING (
	organization_id = (SELECT current_setting('app.organization_id', true))
	AND (
		scope = 'organization'
		OR (scope = 'workspace' AND workspace_id = ANY((SELECT current_setting('app.workspace_ids', true))::uuid[]))
		OR (scope = 'user' AND user_id = (SELECT current_setting('app.user_id', true)))
	)
	AND (
		cardinality(source_data_workspace_ids) = 0
		OR source_data_workspace_ids <@ (SELECT current_setting('app.workspace_ids', true))::uuid[]
	)
);--> statement-breakpoint
CREATE POLICY "ai_memory_insert" ON "ai_memories" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (
	organization_id = (SELECT current_setting('app.organization_id', true))
	AND (
		scope = 'organization'
		OR (scope = 'workspace' AND workspace_id = ANY((SELECT current_setting('app.workspace_ids', true))::uuid[]))
		OR (scope = 'user' AND user_id = (SELECT current_setting('app.user_id', true)))
	)
	AND (
		cardinality(source_data_workspace_ids) = 0
		OR source_data_workspace_ids <@ (SELECT current_setting('app.workspace_ids', true))::uuid[]
	)
);--> statement-breakpoint
CREATE POLICY "ai_memory_update" ON "ai_memories" AS PERMISSIVE FOR UPDATE TO "stella" USING (
	organization_id = (SELECT current_setting('app.organization_id', true))
	AND (
		scope = 'organization'
		OR (scope = 'workspace' AND workspace_id = ANY((SELECT current_setting('app.workspace_ids', true))::uuid[]))
		OR (scope = 'user' AND user_id = (SELECT current_setting('app.user_id', true)))
	)
	AND (
		cardinality(source_data_workspace_ids) = 0
		OR source_data_workspace_ids <@ (SELECT current_setting('app.workspace_ids', true))::uuid[]
	)
);--> statement-breakpoint
CREATE POLICY "ai_memory_no_delete" ON "ai_memories" AS RESTRICTIVE FOR DELETE TO "stella" USING (false);
