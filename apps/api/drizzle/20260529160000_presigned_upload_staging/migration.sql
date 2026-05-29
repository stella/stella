-- Staging table for the presigned-upload migration. Tracked in
-- stella-infra issue #184. Each row records the API's intent to
-- accept an upload to S3 `tmp/{id}` and provides idempotent state
-- for the finalize handler. RLS pins rows to a single workspace.

CREATE TABLE "pending_uploads" (
  "id" uuid PRIMARY KEY,
  "organization_id" varchar(128) NOT NULL,
  "workspace_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "purpose" text NOT NULL,
  "purpose_data" jsonb NOT NULL,
  "declared_name" varchar(255) NOT NULL,
  "declared_mime" varchar(255) NOT NULL,
  "declared_size" bigint NOT NULL,
  "declared_sha256" varchar(64) NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "finalized_result" jsonb,
  "reject_reason" text,
  "claimed_at" timestamp,
  "claimed_by_request_id" varchar(64),
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "finalized_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "pending_uploads" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX "pending_uploads_ws_status_created_idx"
  ON "pending_uploads" ("workspace_id", "status", "created_at");
--> statement-breakpoint
CREATE INDEX "pending_uploads_org_created_idx"
  ON "pending_uploads" ("organization_id", "created_at");
--> statement-breakpoint
ALTER TABLE "pending_uploads"
  ADD CONSTRAINT "pending_uploads_workspace_id_workspaces_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "pending_uploads"
  ADD CONSTRAINT "pending_uploads_user_id_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE POLICY "workspace_select" ON "pending_uploads"
  AS PERMISSIVE FOR SELECT TO "stella"
  USING (workspace_id = ANY((SELECT current_setting(
    'app.workspace_ids', true
  ))::uuid[]));
--> statement-breakpoint
CREATE POLICY "workspace_insert" ON "pending_uploads"
  AS PERMISSIVE FOR INSERT TO "stella"
  WITH CHECK (workspace_id = ANY((SELECT current_setting(
    'app.workspace_ids', true
  ))::uuid[]));
--> statement-breakpoint
CREATE POLICY "workspace_update" ON "pending_uploads"
  AS PERMISSIVE FOR UPDATE TO "stella"
  USING (workspace_id = ANY((SELECT current_setting(
    'app.workspace_ids', true
  ))::uuid[]));
--> statement-breakpoint
CREATE POLICY "workspace_delete" ON "pending_uploads"
  AS PERMISSIVE FOR DELETE TO "stella"
  USING (workspace_id = ANY((SELECT current_setting(
    'app.workspace_ids', true
  ))::uuid[]));
--> statement-breakpoint
-- Bootstrap migration grants table-level permissions in a single
-- sweep; new RLS-enabled tables miss that, so grant explicitly here.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "pending_uploads" TO stella;
