SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "entity_deletion_cleanup_requests" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "workspace_id" uuid NOT NULL,
  "s3_keys" text[] NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "error_message" text,
  "next_attempt_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "completed_at" timestamptz,
  CONSTRAINT "entity_deletion_cleanup_status_values_check"
    CHECK ("status" IN ('pending', 'processing', 'completed', 'failed')),
  CONSTRAINT "entity_deletion_cleanup_attempt_count_nonnegative_check"
    CHECK ("attempt_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX "entity_deletion_cleanup_pending_schedule_idx"
  ON "entity_deletion_cleanup_requests" ("created_at", "id")
  WHERE "status" = 'pending';
--> statement-breakpoint
CREATE INDEX "entity_deletion_cleanup_failed_schedule_idx"
  ON "entity_deletion_cleanup_requests" ("next_attempt_at", "id")
  WHERE "status" = 'failed';
--> statement-breakpoint
CREATE INDEX "entity_deletion_cleanup_processing_lease_idx"
  ON "entity_deletion_cleanup_requests" ("updated_at", "id")
  WHERE "status" = 'processing';
--> statement-breakpoint
-- Cleanup rows contain storage keys and are only read/transitioned by rootDb
-- workers. Scoped requests may insert one only for their active tenant.
ALTER TABLE "entity_deletion_cleanup_requests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "entity_deletion_cleanup_requests" FROM stella;
--> statement-breakpoint
GRANT INSERT ON TABLE "entity_deletion_cleanup_requests" TO stella;
--> statement-breakpoint
CREATE POLICY "entity_deletion_cleanup_insert"
  ON "entity_deletion_cleanup_requests"
  AS PERMISSIVE FOR INSERT TO stella
  WITH CHECK ((CASE
    WHEN workspace_id = ANY(
      COALESCE(
        NULLIF(
          (SELECT pg_catalog.current_setting('app.workspace_ids', true)),
          ''
        )::uuid[],
        ARRAY[]::uuid[]
      )
    ) THEN true
    ELSE workspace_id IN (
      SELECT aw.authorized_workspace_id
      FROM public.stella_authorized_workspaces aw
    )
  END) AND organization_id = (SELECT current_setting(
    'app.organization_id', true
  )));
