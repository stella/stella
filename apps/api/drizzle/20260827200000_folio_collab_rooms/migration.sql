SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Build the uniqueness boundary on the live version table without blocking
-- document writes. A duplicate version number makes the migration fail before
-- the undeployed collaboration tables are replaced.
-- squawk-ignore transaction-nesting
COMMIT;--> statement-breakpoint
SET statement_timeout = 0;--> statement-breakpoint
SET lock_timeout = 0;--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "entity_versions_entity_number_uidx"
  ON "entity_versions" ("entity_id", "version_number");--> statement-breakpoint
REINDEX INDEX CONCURRENTLY "entity_versions_entity_number_uidx";--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
SET lock_timeout = '1s';--> statement-breakpoint
-- squawk-ignore transaction-nesting, ban-uncommitted-transaction
BEGIN;--> statement-breakpoint

-- stella-migration-safety: reviewed drop-object - Browser collaboration is
-- feature-gated, has no deployed service, and its session tokens have no
-- retention value; rollback recreates empty session tables.
DROP TABLE "folio_collab_session_tokens";--> statement-breakpoint
-- stella-migration-safety: reviewed drop-object - Browser collaboration is
-- feature-gated, has no deployed service, and no persisted session state needs
-- retention; rollback recreates an empty session table.
DROP TABLE "folio_collab_sessions";--> statement-breakpoint

CREATE TABLE "folio_collab_rooms" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "property_id" uuid NOT NULL,
  "generation" bigint DEFAULT 0 NOT NULL,
  "base_version_id" uuid NOT NULL,
  "file_name" varchar(256) NOT NULL,
  "yjs_snapshot_file_id" uuid NOT NULL,
  "yjs_snapshot_size_bytes" integer,
  "yjs_snapshot_updated_at" timestamptz,
  "docx_checkpoint_file_id" uuid NOT NULL,
  "docx_checkpoint_sha256_hex" varchar(64),
  "docx_checkpoint_size_bytes" integer,
  "docx_checkpoint_scan_warnings" jsonb,
  "docx_checkpoint_updated_at" timestamptz,
  "seed_state" text DEFAULT 'empty' NOT NULL,
  "seed_claimed_by" text,
  "seed_claimed_at" timestamptz,
  "seeded_at" timestamptz,
  "last_activity_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "folio_collab_rooms_generation_check"
    CHECK ("generation" >= 0),
  CONSTRAINT "folio_collab_rooms_seed_state_check"
    CHECK ("seed_state" IN ('empty', 'claimed', 'seeded')),
  CONSTRAINT "folio_collab_rooms_seed_fields_check"
    CHECK (
      ("seed_state" = 'empty' AND "seed_claimed_by" IS NULL AND "seed_claimed_at" IS NULL AND "seeded_at" IS NULL AND "yjs_snapshot_size_bytes" IS NULL AND "yjs_snapshot_updated_at" IS NULL)
      OR ("seed_state" = 'claimed' AND "seed_claimed_by" IS NOT NULL AND "seed_claimed_at" IS NOT NULL AND "seeded_at" IS NULL AND "yjs_snapshot_size_bytes" IS NULL AND "yjs_snapshot_updated_at" IS NULL)
      OR ("seed_state" = 'seeded' AND "seed_claimed_at" IS NOT NULL AND "seeded_at" IS NOT NULL AND "yjs_snapshot_size_bytes" IS NOT NULL AND "yjs_snapshot_updated_at" IS NOT NULL)
    ),
  CONSTRAINT "folio_collab_rooms_snapshot_size_check"
    CHECK ("yjs_snapshot_size_bytes" IS NULL OR ("yjs_snapshot_size_bytes" >= 0 AND "yjs_snapshot_size_bytes" <= 10485760)),
  CONSTRAINT "folio_collab_rooms_checkpoint_size_check"
    CHECK ("docx_checkpoint_size_bytes" IS NULL OR ("docx_checkpoint_size_bytes" >= 0 AND "docx_checkpoint_size_bytes" <= 52428800))
);--> statement-breakpoint
ALTER TABLE "folio_collab_rooms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TABLE "folio_collab_room_tokens" (
  "id" uuid PRIMARY KEY,
  "room_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "token_hash" varchar(64) NOT NULL,
  "generation" bigint NOT NULL,
  "permissions" jsonb NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "folio_collab_room_tokens_generation_check"
    CHECK ("generation" >= 0)
);--> statement-breakpoint
ALTER TABLE "folio_collab_room_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "folio_collab_rooms"
  ADD CONSTRAINT "folio_collab_rooms_workspace_id_workspaces_id_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "folio_collab_rooms"
  ADD CONSTRAINT "folio_collab_rooms_base_version_id_entity_versions_id_fk"
  FOREIGN KEY ("base_version_id") REFERENCES "entity_versions"("id");--> statement-breakpoint
ALTER TABLE "folio_collab_rooms"
  ADD CONSTRAINT "folio_collab_rooms_seed_claimed_by_user_id_fk"
  FOREIGN KEY ("seed_claimed_by") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "folio_collab_rooms"
  ADD CONSTRAINT "folio_collab_rooms_entity_workspace_fk"
  FOREIGN KEY ("entity_id", "workspace_id") REFERENCES "entities"("id", "workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "folio_collab_rooms"
  ADD CONSTRAINT "folio_collab_rooms_property_workspace_fk"
  FOREIGN KEY ("property_id", "workspace_id") REFERENCES "properties"("id", "workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "folio_collab_room_tokens"
  ADD CONSTRAINT "folio_collab_room_tokens_workspace_id_workspaces_id_fk"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "folio_collab_room_tokens"
  ADD CONSTRAINT "folio_collab_room_tokens_user_id_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint

CREATE UNIQUE INDEX "folio_collab_rooms_target_uidx"
  ON "folio_collab_rooms" ("workspace_id", "entity_id", "property_id");--> statement-breakpoint
CREATE UNIQUE INDEX "folio_collab_rooms_id_workspace_uidx"
  ON "folio_collab_rooms" ("id", "workspace_id");--> statement-breakpoint
CREATE INDEX "folio_collab_rooms_workspace_entity_idx"
  ON "folio_collab_rooms" ("workspace_id", "entity_id");--> statement-breakpoint
CREATE INDEX "folio_collab_rooms_workspace_property_idx"
  ON "folio_collab_rooms" ("workspace_id", "property_id");--> statement-breakpoint
CREATE INDEX "folio_collab_rooms_workspace_activity_idx"
  ON "folio_collab_rooms" ("workspace_id", "last_activity_at");--> statement-breakpoint
CREATE INDEX "folio_collab_room_tokens_workspace_expiry_idx"
  ON "folio_collab_room_tokens" ("workspace_id", "expires_at");--> statement-breakpoint
CREATE INDEX "folio_collab_room_tokens_room_id_idx"
  ON "folio_collab_room_tokens" ("room_id");--> statement-breakpoint
CREATE INDEX "folio_collab_room_tokens_user_id_idx"
  ON "folio_collab_room_tokens" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "folio_collab_room_tokens_token_hash_uidx"
  ON "folio_collab_room_tokens" ("token_hash");--> statement-breakpoint

ALTER TABLE "folio_collab_room_tokens"
  ADD CONSTRAINT "folio_collab_room_tokens_room_workspace_fk"
  FOREIGN KEY ("room_id", "workspace_id")
  REFERENCES "folio_collab_rooms"("id", "workspace_id") ON DELETE CASCADE;--> statement-breakpoint

CREATE POLICY "workspace_select" ON "folio_collab_rooms"
  AS PERMISSIVE FOR SELECT TO "stella"
  USING (workspace_id = ANY((SELECT current_setting('app.workspace_ids', true))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "folio_collab_rooms"
  AS PERMISSIVE FOR INSERT TO "stella"
  WITH CHECK (workspace_id = ANY((SELECT current_setting('app.workspace_ids', true))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "folio_collab_rooms"
  AS PERMISSIVE FOR UPDATE TO "stella"
  USING (workspace_id = ANY((SELECT current_setting('app.workspace_ids', true))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "folio_collab_rooms"
  AS PERMISSIVE FOR DELETE TO "stella"
  USING (workspace_id = ANY((SELECT current_setting('app.workspace_ids', true))::uuid[]));--> statement-breakpoint

CREATE POLICY "workspace_select" ON "folio_collab_room_tokens"
  AS PERMISSIVE FOR SELECT TO "stella"
  USING (workspace_id = ANY((SELECT current_setting('app.workspace_ids', true))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "folio_collab_room_tokens"
  AS PERMISSIVE FOR INSERT TO "stella"
  WITH CHECK (workspace_id = ANY((SELECT current_setting('app.workspace_ids', true))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "folio_collab_room_tokens"
  AS PERMISSIVE FOR UPDATE TO "stella"
  USING (workspace_id = ANY((SELECT current_setting('app.workspace_ids', true))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "folio_collab_room_tokens"
  AS PERMISSIVE FOR DELETE TO "stella"
  USING (workspace_id = ANY((SELECT current_setting('app.workspace_ids', true))::uuid[]));--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "folio_collab_rooms",
  "folio_collab_room_tokens"
TO stella;
