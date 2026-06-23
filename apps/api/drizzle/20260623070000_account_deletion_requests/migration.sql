SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "user"
  ADD COLUMN "deleted_at" timestamp;
--> statement-breakpoint
CREATE TABLE "account_deletion_requests" (
  "id" uuid PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "organization_ids" varchar(128)[] DEFAULT '{}' NOT NULL,
  "workspace_ids" uuid[] DEFAULT '{}' NOT NULL,
  "task_reassignment_count" integer DEFAULT 0 NOT NULL,
  "status" varchar(16) DEFAULT 'pending' NOT NULL,
  "storage_cleanup" jsonb NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "error_message" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "account_deletion_requests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "account_deletion_requests"
  ADD CONSTRAINT "account_deletion_requests_user_id_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "account_deletion_requests_user_created_idx"
  ON "account_deletion_requests" ("user_id", "created_at", "id");
--> statement-breakpoint
CREATE INDEX "account_deletion_requests_status_created_idx"
  ON "account_deletion_requests" ("status", "created_at", "id");
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "account_deletion_requests" TO stella;
--> statement-breakpoint
GRANT SELECT ("deleted_at") ON TABLE "user" TO stella;
--> statement-breakpoint
DROP POLICY "auth_user_select" ON "user";
--> statement-breakpoint
CREATE POLICY "auth_user_select" ON "user" AS PERMISSIVE FOR SELECT TO "stella" USING ((
  id = (SELECT current_setting('app.user_id', true))
  OR EXISTS (
    SELECT 1
    FROM member m
    WHERE m.user_id = "user".id
      AND m.organization_id = (SELECT current_setting('app.organization_id', true))
  )
  OR EXISTS (
    SELECT 1
    FROM task_assignees ta
    JOIN workspaces w ON w.id = ta.workspace_id
    WHERE ta.user_id = "user".id
      AND ta.workspace_id = ANY((SELECT current_setting('app.workspace_ids', true))::uuid[])
      AND w.organization_id = (SELECT current_setting('app.organization_id', true))
  )
  OR EXISTS (
    SELECT 1
    FROM entities e
    JOIN workspaces w ON w.id = e.workspace_id
    WHERE (e.created_by = "user".id OR e.last_edited_by = "user".id)
      AND e.workspace_id = ANY((SELECT current_setting('app.workspace_ids', true))::uuid[])
      AND w.organization_id = (SELECT current_setting('app.organization_id', true))
  )
));
--> statement-breakpoint
CREATE POLICY "user_select" ON "account_deletion_requests"
  AS PERMISSIVE FOR SELECT TO "stella"
  USING (user_id = (SELECT current_setting('app.user_id', true)));
--> statement-breakpoint
CREATE POLICY "user_insert" ON "account_deletion_requests"
  AS PERMISSIVE FOR INSERT TO "stella"
  WITH CHECK (user_id = (SELECT current_setting('app.user_id', true)));
--> statement-breakpoint
CREATE POLICY "user_update" ON "account_deletion_requests"
  AS PERMISSIVE FOR UPDATE TO "stella"
  USING (user_id = (SELECT current_setting('app.user_id', true)));
--> statement-breakpoint
CREATE POLICY "user_delete" ON "account_deletion_requests"
  AS PERMISSIVE FOR DELETE TO "stella"
  USING (user_id = (SELECT current_setting('app.user_id', true)));
