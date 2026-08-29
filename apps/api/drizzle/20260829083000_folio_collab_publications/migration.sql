SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

ALTER TABLE "entity_versions"
  ADD COLUMN "collaboration_contributor_user_ids" jsonb;--> statement-breakpoint
ALTER TABLE "entity_versions"
  ADD CONSTRAINT "entity_versions_collaboration_contributors_check"
  CHECK (
    "collaboration_contributor_user_ids" IS NULL
    OR (
      jsonb_typeof("collaboration_contributor_user_ids") = 'array'
      AND jsonb_array_length("collaboration_contributor_user_ids") <= 50
    )
  ) NOT VALID;--> statement-breakpoint

CREATE TABLE "folio_collab_contributions" (
  "id" uuid PRIMARY KEY,
  "room_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "since_version_id" uuid NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "folio_collab_contributions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TABLE "folio_collab_publications" (
  "id" uuid PRIMARY KEY,
  "room_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "entity_version_id" uuid NOT NULL,
  "idempotency_key" varchar(128) NOT NULL,
  "generation" bigint NOT NULL,
  "checkpoint_sha256_hex" varchar(64) NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "folio_collab_publications_generation_check" CHECK ("generation" >= 0)
);--> statement-breakpoint
ALTER TABLE "folio_collab_publications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "folio_collab_contributions"
  ADD CONSTRAINT "folio_collab_contributions_user_id_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "folio_collab_contributions"
  ADD CONSTRAINT "folio_collab_contributions_room_workspace_fk"
  FOREIGN KEY ("room_id", "workspace_id")
  REFERENCES "folio_collab_rooms"("id", "workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "folio_collab_contributions"
  ADD CONSTRAINT "folio_collab_contributions_version_entity_workspace_fk"
  FOREIGN KEY ("since_version_id", "entity_id", "workspace_id")
  REFERENCES "entity_versions"("id", "entity_id", "workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "folio_collab_publications"
  ADD CONSTRAINT "folio_collab_publications_room_workspace_fk"
  FOREIGN KEY ("room_id", "workspace_id")
  REFERENCES "folio_collab_rooms"("id", "workspace_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "folio_collab_publications"
  ADD CONSTRAINT "folio_collab_publications_version_entity_workspace_fk"
  FOREIGN KEY ("entity_version_id", "entity_id", "workspace_id")
  REFERENCES "entity_versions"("id", "entity_id", "workspace_id") ON DELETE CASCADE;--> statement-breakpoint

CREATE UNIQUE INDEX "folio_collab_contributions_room_user_uidx"
  ON "folio_collab_contributions" ("room_id", "user_id");--> statement-breakpoint
CREATE INDEX "folio_collab_contributions_workspace_room_idx"
  ON "folio_collab_contributions" ("workspace_id", "room_id");--> statement-breakpoint
CREATE UNIQUE INDEX "folio_collab_publications_idempotency_uidx"
  ON "folio_collab_publications" ("idempotency_key");--> statement-breakpoint
CREATE INDEX "folio_collab_publications_workspace_room_idx"
  ON "folio_collab_publications" ("workspace_id", "room_id");--> statement-breakpoint

CREATE POLICY "workspace_select" ON "folio_collab_contributions"
  AS PERMISSIVE FOR SELECT TO "stella"
  USING (workspace_id = ANY((SELECT current_setting('app.workspace_ids', true))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "folio_collab_contributions"
  AS PERMISSIVE FOR INSERT TO "stella"
  WITH CHECK (workspace_id = ANY((SELECT current_setting('app.workspace_ids', true))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "folio_collab_contributions"
  AS PERMISSIVE FOR UPDATE TO "stella"
  USING (workspace_id = ANY((SELECT current_setting('app.workspace_ids', true))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "folio_collab_contributions"
  AS PERMISSIVE FOR DELETE TO "stella"
  USING (workspace_id = ANY((SELECT current_setting('app.workspace_ids', true))::uuid[]));--> statement-breakpoint

CREATE POLICY "workspace_select" ON "folio_collab_publications"
  AS PERMISSIVE FOR SELECT TO "stella"
  USING (workspace_id = ANY((SELECT current_setting('app.workspace_ids', true))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "folio_collab_publications"
  AS PERMISSIVE FOR INSERT TO "stella"
  WITH CHECK (workspace_id = ANY((SELECT current_setting('app.workspace_ids', true))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_update" ON "folio_collab_publications"
  AS PERMISSIVE FOR UPDATE TO "stella"
  USING (workspace_id = ANY((SELECT current_setting('app.workspace_ids', true))::uuid[]));--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "folio_collab_publications"
  AS PERMISSIVE FOR DELETE TO "stella"
  USING (workspace_id = ANY((SELECT current_setting('app.workspace_ids', true))::uuid[]));--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "folio_collab_contributions",
  "folio_collab_publications"
TO stella;
