SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "template_deletion_cleanup_requests" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "s3_keys" text[] NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "error_message" text,
  "next_attempt_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "completed_at" timestamptz,
  CONSTRAINT "template_deletion_cleanup_status_values_check"
    CHECK ("status" IN ('pending', 'processing', 'completed', 'failed')),
  CONSTRAINT "template_deletion_cleanup_attempt_count_nonnegative_check"
    CHECK ("attempt_count" >= 0)
);--> statement-breakpoint

CREATE INDEX "template_deletion_cleanup_pending_schedule_idx"
  ON "template_deletion_cleanup_requests" ("created_at", "id")
  WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX "template_deletion_cleanup_failed_schedule_idx"
  ON "template_deletion_cleanup_requests" ("next_attempt_at", "id")
  WHERE "status" = 'failed';--> statement-breakpoint
CREATE INDEX "template_deletion_cleanup_processing_lease_idx"
  ON "template_deletion_cleanup_requests" ("updated_at", "id")
  WHERE "status" = 'processing';--> statement-breakpoint

ALTER TABLE "template_deletion_cleanup_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE "template_deletion_cleanup_requests" FROM stella;--> statement-breakpoint
GRANT INSERT ON TABLE "template_deletion_cleanup_requests" TO stella;--> statement-breakpoint
CREATE POLICY "template_deletion_cleanup_insert"
  ON "template_deletion_cleanup_requests"
  AS PERMISSIVE FOR INSERT TO stella
  WITH CHECK (organization_id = (SELECT current_setting(
    'app.organization_id', true
  )));
