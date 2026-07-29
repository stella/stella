SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "share_spaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(256) NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"download_policy" text DEFAULT 'blocked' NOT NULL,
	"access_token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_spaces_id_workspace_org_unq" UNIQUE("id", "workspace_id", "organization_id"),
	CONSTRAINT "share_spaces_revocation_state_check" CHECK (
		("status" = 'revoked' AND "revoked_at" IS NOT NULL)
		OR ("status" <> 'revoked' AND "revoked_at" IS NULL)
	),
	CONSTRAINT "share_spaces_access_token_hash_check" CHECK ("access_token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "share_recipients" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"share_space_id" uuid NOT NULL,
	"email_normalized" varchar(320) NOT NULL,
	"user_id" text,
	"role" text DEFAULT 'viewer' NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"invited_by" text,
	"verified_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_access_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_recipients_email_normalized_check" CHECK ("email_normalized" = lower(trim("email_normalized"))),
	CONSTRAINT "share_recipients_verification_state_check" CHECK (
		("status" = 'verified' AND "user_id" IS NOT NULL AND "verified_at" IS NOT NULL AND "revoked_at" IS NULL)
		OR ("status" = 'invited' AND "verified_at" IS NULL AND "revoked_at" IS NULL)
		OR ("status" = 'revoked' AND "revoked_at" IS NOT NULL)
	)
);
--> statement-breakpoint
CREATE TABLE "share_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"share_space_id" uuid NOT NULL,
	"source_entity_id" uuid NOT NULL,
	"source_entity_version_id" uuid NOT NULL,
	"source_field_id" uuid NOT NULL,
	"display_name" varchar(512) NOT NULL,
	"display_path" varchar(2048),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'publishing' NOT NULL,
	"original_file_name" varchar(256) NOT NULL,
	"original_mime_type" varchar(255) NOT NULL,
	"original_size_bytes" bigint NOT NULL,
	"original_sha256_hex" varchar(64) NOT NULL,
	"original_storage_key" text,
	"display_mime_type" varchar(255),
	"display_storage_key" text,
	"thumbnail_storage_key" text,
	"version_stamp" varchar(128),
	"verification_code" varchar(16),
	"failure_code" varchar(64),
	"published_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_items_original_sha256_check" CHECK ("original_sha256_hex" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "share_items_original_size_check" CHECK ("original_size_bytes" >= 0),
	CONSTRAINT "share_items_asset_state_check" CHECK (
		("status" = 'ready'
			AND "original_storage_key" IS NOT NULL
			AND "display_storage_key" IS NOT NULL
			AND "display_mime_type" IS NOT NULL
			AND "published_at" IS NOT NULL
			AND "failure_code" IS NULL
			AND "withdrawn_at" IS NULL)
		OR ("status" = 'publishing'
			AND "published_at" IS NULL
			AND "failure_code" IS NULL
			AND "withdrawn_at" IS NULL)
		OR ("status" = 'failed'
			AND "failure_code" IS NOT NULL
			AND "published_at" IS NULL
			AND "withdrawn_at" IS NULL)
		OR ("status" = 'withdrawn' AND "withdrawn_at" IS NOT NULL)
	)
);
--> statement-breakpoint
ALTER TABLE "share_spaces" ADD CONSTRAINT "share_spaces_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "share_spaces" ADD CONSTRAINT "share_spaces_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "share_spaces" ADD CONSTRAINT "share_spaces_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "share_recipients" ADD CONSTRAINT "share_recipients_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "share_recipients" ADD CONSTRAINT "share_recipients_share_space_workspace_org_fk" FOREIGN KEY ("share_space_id", "workspace_id", "organization_id") REFERENCES "share_spaces"("id", "workspace_id", "organization_id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "share_items" ADD CONSTRAINT "share_items_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "share_items" ADD CONSTRAINT "share_items_share_space_workspace_org_fk" FOREIGN KEY ("share_space_id", "workspace_id", "organization_id") REFERENCES "share_spaces"("id", "workspace_id", "organization_id") ON DELETE cascade;--> statement-breakpoint

CREATE UNIQUE INDEX "share_spaces_access_token_hash_uidx" ON "share_spaces" USING btree ("access_token_hash");--> statement-breakpoint
CREATE INDEX "share_spaces_workspace_created_id_idx" ON "share_spaces" USING btree ("workspace_id", "created_at", "id");--> statement-breakpoint
CREATE INDEX "share_spaces_org_workspace_idx" ON "share_spaces" USING btree ("organization_id", "workspace_id");--> statement-breakpoint
CREATE INDEX "share_spaces_active_expiry_idx" ON "share_spaces" USING btree ("expires_at") WHERE "status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "share_recipients_space_email_uidx" ON "share_recipients" USING btree ("share_space_id", "email_normalized");--> statement-breakpoint
CREATE UNIQUE INDEX "share_recipients_space_user_uidx" ON "share_recipients" USING btree ("share_space_id", "user_id") WHERE "user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "share_recipients_workspace_space_idx" ON "share_recipients" USING btree ("workspace_id", "share_space_id");--> statement-breakpoint
CREATE INDEX "share_recipients_user_id_idx" ON "share_recipients" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "share_items_space_source_version_uidx" ON "share_items" USING btree ("share_space_id", "source_entity_version_id");--> statement-breakpoint
CREATE INDEX "share_items_space_created_id_idx" ON "share_items" USING btree ("share_space_id", "created_at", "id");--> statement-breakpoint
CREATE INDEX "share_items_workspace_source_entity_idx" ON "share_items" USING btree ("workspace_id", "source_entity_id");--> statement-breakpoint

ALTER TABLE "share_spaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "share_recipients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "share_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "share_spaces", "share_recipients", "share_items" TO stella;--> statement-breakpoint

CREATE POLICY "share_spaces_select" ON "share_spaces" AS PERMISSIVE FOR SELECT TO "stella" USING (
	CASE
		WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true
		ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
	END
	OR (
		id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.share_space_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
		AND status = 'active'
		AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
	)
);--> statement-breakpoint
CREATE POLICY "share_spaces_insert" ON "share_spaces" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (
	CASE
		WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true
		ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
	END
);--> statement-breakpoint
CREATE POLICY "share_spaces_update" ON "share_spaces" AS PERMISSIVE FOR UPDATE TO "stella" USING (
	CASE
		WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true
		ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
	END
) WITH CHECK (
	CASE
		WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true
		ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
	END
);--> statement-breakpoint
CREATE POLICY "share_spaces_delete" ON "share_spaces" AS PERMISSIVE FOR DELETE TO "stella" USING (
	CASE
		WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true
		ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
	END
);--> statement-breakpoint

CREATE POLICY "share_recipients_select" ON "share_recipients" AS PERMISSIVE FOR SELECT TO "stella" USING (
	CASE
		WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true
		ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
	END
	OR (
		share_space_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.share_space_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
		AND EXISTS (
			SELECT 1 FROM share_spaces authorized_share_space
			WHERE authorized_share_space.id = share_space_id
				AND authorized_share_space.status = 'active'
				AND (authorized_share_space.expires_at IS NULL OR authorized_share_space.expires_at > CURRENT_TIMESTAMP)
		)
		AND user_id = (SELECT pg_catalog.current_setting('app.user_id', true))
		AND status = 'verified'
	)
);--> statement-breakpoint
CREATE POLICY "share_recipients_insert" ON "share_recipients" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (
	CASE
		WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true
		ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
	END
);--> statement-breakpoint
CREATE POLICY "share_recipients_update" ON "share_recipients" AS PERMISSIVE FOR UPDATE TO "stella" USING (
	CASE
		WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true
		ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
	END
) WITH CHECK (
	CASE
		WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true
		ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
	END
);--> statement-breakpoint
CREATE POLICY "share_recipients_delete" ON "share_recipients" AS PERMISSIVE FOR DELETE TO "stella" USING (
	CASE
		WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true
		ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
	END
);--> statement-breakpoint

CREATE POLICY "share_items_select" ON "share_items" AS PERMISSIVE FOR SELECT TO "stella" USING (
	CASE
		WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true
		ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
	END
	OR (
		share_space_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.share_space_ids', true)), '')::uuid[], ARRAY[]::uuid[]))
		AND EXISTS (
			SELECT 1 FROM share_spaces authorized_share_space
			WHERE authorized_share_space.id = share_space_id
				AND authorized_share_space.status = 'active'
				AND (authorized_share_space.expires_at IS NULL OR authorized_share_space.expires_at > CURRENT_TIMESTAMP)
		)
		AND status = 'ready'
	)
);--> statement-breakpoint
CREATE POLICY "share_items_insert" ON "share_items" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (
	CASE
		WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true
		ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
	END
);--> statement-breakpoint
CREATE POLICY "share_items_update" ON "share_items" AS PERMISSIVE FOR UPDATE TO "stella" USING (
	CASE
		WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true
		ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
	END
) WITH CHECK (
	CASE
		WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true
		ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
	END
);--> statement-breakpoint
CREATE POLICY "share_items_delete" ON "share_items" AS PERMISSIVE FOR DELETE TO "stella" USING (
	CASE
		WHEN workspace_id = ANY(COALESCE(NULLIF((SELECT pg_catalog.current_setting('app.workspace_ids', true)), '')::uuid[], ARRAY[]::uuid[])) THEN true
		ELSE workspace_id IN (SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw)
	END
);
