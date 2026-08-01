SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
CREATE TABLE "ai_memories" (
	"id" uuid PRIMARY KEY,
	"organization_id" varchar(128) NOT NULL,
	"scope" text NOT NULL,
	"user_id" text,
	"workspace_id" uuid,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"dedup_key" varchar(64) NOT NULL,
	"language" varchar(10),
	"source_data_workspace_ids" uuid[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	"source_message_id" uuid,
	"confidence" double precision,
	"created_by" text,
	"superseded_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "chat_thread_compactions" ADD COLUMN "memory_extracted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_thread_compactions" ADD COLUMN "memory_extraction_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_thread_compactions" ADD COLUMN "memory_extraction_organization_id" varchar(128);--> statement-breakpoint
ALTER TABLE "chat_thread_compactions" ADD COLUMN "memory_extraction_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_thread_compactions" ADD COLUMN "memory_extraction_data_workspace_ids" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_memories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ai_memories" TO stella;--> statement-breakpoint
CREATE INDEX "ai_memories_org_scope_status_idx" ON "ai_memories" ("organization_id", "scope", "status");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_memories_org_dedup_uidx" ON "ai_memories" ("organization_id", "dedup_key");--> statement-breakpoint
CREATE INDEX "ai_memories_org_status_created_idx" ON "ai_memories" ("organization_id", "status", "created_at", "id");--> statement-breakpoint
CREATE INDEX "ai_memories_user_status_idx" ON "ai_memories" ("user_id", "status") WHERE user_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ai_memories_workspace_status_idx" ON "ai_memories" ("workspace_id", "status") WHERE workspace_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ai_memories_source_message_idx" ON "ai_memories" ("source_message_id") WHERE source_message_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ai_memories_active_lifecycle_idx" ON "ai_memories" ("last_used_at") WHERE status = 'active' AND pinned = false;--> statement-breakpoint
CREATE INDEX "ai_memories_stale_lifecycle_idx" ON "ai_memories" ("last_used_at") WHERE status = 'stale' AND pinned = false;--> statement-breakpoint
CREATE INDEX "ai_memories_suggested_lifecycle_idx" ON "ai_memories" ("created_at") WHERE status = 'suggested' AND pinned = false;--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_source_message_id_chat_messages_id_fkey" FOREIGN KEY ("source_message_id") REFERENCES "chat_messages"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_created_by_user_id_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_superseded_by_id_ai_memories_id_fkey" FOREIGN KEY ("superseded_by_id") REFERENCES "ai_memories"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "chat_thread_compactions" ADD CONSTRAINT "chat_compactions_memory_extraction_org_fk" FOREIGN KEY ("memory_extraction_organization_id") REFERENCES "organization"("id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_scope_ids_check" CHECK (
	(scope = 'organization' AND user_id IS NULL AND workspace_id IS NULL)
	OR (scope = 'user' AND user_id IS NOT NULL AND workspace_id IS NULL)
	OR (scope = 'workspace' AND workspace_id IS NOT NULL AND user_id IS NULL)
);--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_kind_scope_check" CHECK (kind IN ('preference', 'instruction') OR scope = 'workspace');--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_kind_check" CHECK (kind IN ('preference', 'instruction', 'fact', 'decision', 'relationship'));--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_status_check" CHECK (status IN ('suggested', 'active', 'stale', 'archived'));--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_source_check" CHECK (source IN ('user', 'tool', 'extracted'));--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_confidence_check" CHECK (confidence IS NULL OR (source = 'extracted' AND confidence >= 0 AND confidence <= 1));--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_dedup_key_check" CHECK (dedup_key ~ '^[0-9a-f]{64}$');--> statement-breakpoint
CREATE POLICY "ai_memory_select" ON "ai_memories" AS PERMISSIVE FOR SELECT TO "stella" USING (
	organization_id = (SELECT current_setting('app.organization_id', true))
	AND (
		status <> 'suggested'
		OR created_by = (SELECT current_setting('app.user_id', true))
	)
	AND (
		scope = 'organization'
		OR (scope = 'workspace' AND workspace_id IN (
			SELECT aw.authorized_workspace_id
			FROM public.stella_authorized_workspaces aw
			WHERE aw.workspace_status <> 'deleting'
		))
		OR (scope = 'user' AND user_id = (SELECT current_setting('app.user_id', true)))
	)
	AND (
		cardinality(source_data_workspace_ids) = 0
		OR NOT EXISTS (
			SELECT 1
			FROM pg_catalog.unnest(source_data_workspace_ids) AS scoped_workspace(workspace_id)
			WHERE scoped_workspace.workspace_id IS NULL
				OR NOT (
					scoped_workspace.workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
					OR EXISTS (
						SELECT 1 FROM public.stella_authorized_workspaces aw
						WHERE aw.authorized_workspace_id = scoped_workspace.workspace_id
							AND aw.workspace_status <> 'deleting'
					)
				)
		)
	)
);--> statement-breakpoint
CREATE POLICY "ai_memory_insert" ON "ai_memories" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (
	organization_id = (SELECT current_setting('app.organization_id', true))
	AND (
		status <> 'suggested'
		OR created_by = (SELECT current_setting('app.user_id', true))
	)
	AND (
		scope = 'organization'
		OR (scope = 'workspace' AND workspace_id IN (
			SELECT aw.authorized_workspace_id
			FROM public.stella_authorized_workspaces aw
			WHERE aw.workspace_status <> 'deleting'
		))
		OR (scope = 'user' AND user_id = (SELECT current_setting('app.user_id', true)))
	)
	AND (
		cardinality(source_data_workspace_ids) = 0
		OR NOT EXISTS (
			SELECT 1
			FROM pg_catalog.unnest(source_data_workspace_ids) AS scoped_workspace(workspace_id)
			WHERE scoped_workspace.workspace_id IS NULL
				OR NOT (
					scoped_workspace.workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
					OR EXISTS (
						SELECT 1 FROM public.stella_authorized_workspaces aw
						WHERE aw.authorized_workspace_id = scoped_workspace.workspace_id
							AND aw.workspace_status <> 'deleting'
					)
				)
		)
	)
);--> statement-breakpoint
CREATE POLICY "ai_memory_update" ON "ai_memories" AS PERMISSIVE FOR UPDATE TO "stella" USING (
	organization_id = (SELECT current_setting('app.organization_id', true))
	AND (
		status <> 'suggested'
		OR created_by = (SELECT current_setting('app.user_id', true))
	)
	AND (
		scope = 'organization'
		OR (scope = 'workspace' AND workspace_id IN (
			SELECT aw.authorized_workspace_id
			FROM public.stella_authorized_workspaces aw
			WHERE aw.workspace_status <> 'deleting'
		))
		OR (scope = 'user' AND user_id = (SELECT current_setting('app.user_id', true)))
	)
	AND (
		cardinality(source_data_workspace_ids) = 0
		OR NOT EXISTS (
			SELECT 1
			FROM pg_catalog.unnest(source_data_workspace_ids) AS scoped_workspace(workspace_id)
			WHERE scoped_workspace.workspace_id IS NULL
				OR NOT (
					scoped_workspace.workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
					OR EXISTS (
						SELECT 1 FROM public.stella_authorized_workspaces aw
						WHERE aw.authorized_workspace_id = scoped_workspace.workspace_id
							AND aw.workspace_status <> 'deleting'
					)
				)
		)
	)
);--> statement-breakpoint
CREATE POLICY "ai_memory_no_delete" ON "ai_memories" AS RESTRICTIVE FOR DELETE TO "stella" USING (false);--> statement-breakpoint
-- Background memory extraction is opt-in per organization; default off.
-- Adding a boolean column with a constant default is a metadata-only
-- change on modern Postgres, so no table rewrite and no lock wait.
ALTER TABLE "organization_settings" ADD COLUMN "memory_extraction_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "memory_extraction_enabled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "memory_extraction_scheduled_at" timestamp with time zone;
--> statement-breakpoint
-- Keep enable/disable transitions and the durable queue inseparable even
-- during a rolling deploy where an older application instance performs the
-- settings write.
CREATE FUNCTION "stella_sync_memory_extraction_queue_on_settings_write"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
	IF NEW.memory_extraction_enabled = true
		AND NEW.memory_extraction_enabled_at IS NOT NULL
	THEN
		IF TG_OP = 'INSERT' THEN
			NEW.memory_extraction_scheduled_at = pg_catalog.now();
		ELSIF OLD.memory_extraction_enabled = false
			OR OLD.memory_extraction_enabled_at IS DISTINCT FROM NEW.memory_extraction_enabled_at
		THEN
			NEW.memory_extraction_scheduled_at = pg_catalog.now();
		END IF;
	ELSE
		NEW.memory_extraction_scheduled_at = NULL;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "organization_settings_sync_memory_extraction_queue"
BEFORE INSERT OR UPDATE OF "memory_extraction_enabled", "memory_extraction_enabled_at"
ON "organization_settings"
FOR EACH ROW
EXECUTE FUNCTION "stella_sync_memory_extraction_queue_on_settings_write"();
--> statement-breakpoint
-- The trigger derives the tenant solely through the compaction's FK-owned
-- thread. SECURITY DEFINER lets ordinary tenant writes wake the root-only
-- scheduler queue without granting application code cross-tenant access.
CREATE FUNCTION "stella_address_and_queue_memory_compaction"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
	SELECT thread.organization_id, thread.data_workspace_ids
	INTO NEW.memory_extraction_organization_id, NEW.memory_extraction_data_workspace_ids
	FROM public.chat_threads AS thread
	WHERE thread.id = NEW.thread_id;
	NEW.memory_extraction_consent_at = NULL;

	IF NEW.memory_extraction_organization_id IS NOT NULL
		AND NEW.memory_extracted_at IS NULL
		AND NEW.status = 'active'
	THEN
		UPDATE public.organization_settings AS settings
		SET memory_extraction_scheduled_at = CASE
			WHEN settings.memory_extraction_scheduled_at IS NULL
				OR settings.memory_extraction_scheduled_at > pg_catalog.now()
			THEN pg_catalog.now()
			ELSE settings.memory_extraction_scheduled_at
		END
		WHERE settings.organization_id = NEW.memory_extraction_organization_id
			AND settings.memory_extraction_enabled = true
			AND settings.memory_extraction_enabled_at IS NOT NULL
			AND NEW.created_at >= settings.memory_extraction_enabled_at
		RETURNING settings.memory_extraction_enabled_at
		INTO NEW.memory_extraction_consent_at;
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "stella_address_and_queue_memory_compaction"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "chat_thread_compactions_address_and_queue_memory"
BEFORE INSERT ON "chat_thread_compactions"
FOR EACH ROW
EXECUTE FUNCTION "stella_address_and_queue_memory_compaction"();
